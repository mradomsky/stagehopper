/**
 * @file All room-page state and behaviour, as a rune class.
 *
 * The page component renders this; it owns no logic of its own. Navigation is
 * injected so the class can be driven in tests without SvelteKit.
 */

import {
	createRoom,
	fetchRoomSelections,
	leaveRoom as leaveRoomRequest,
	putRoomSelections
} from './api.js';
import { getFestivalById, getFestivalByPrefix, isFestivalBrowseId } from './festivals.svelte.js';
import { parseGoogleIdTokenClaims, type GoogleCredentialResponse } from './google-identity.js';
import { haptic } from './haptics.js';
import { generateRoomId, roomPath } from './rooms.js';
import {
	DEFAULT_COLOR,
	cycleState,
	filterPicks,
	filterSelectionsByParticipantIds,
	firstAvailableColor,
	getParticipantMarks,
	mergeSelectionsForViewer,
	normalizeSelectedOtherUserIds,
	stateOf,
	takenColorsExcluding,
	truncateName
} from './selections.js';
import {
	clearGoogleAuth,
	loadGoogleAuth,
	loadLikedIds,
	loadParticipantFilter,
	loadRoomIdentity,
	saveGoogleAuth,
	saveLikedIds,
	saveParticipantFilter,
	saveRoomIdentity
} from './storage.js';
import {
	buildHourMarkers,
	clockMinutes,
	computeGridStart,
	getCurrentDayIdx,
	getInitialDayIdx,
	GRID_SPAN_MIN,
	projectClockMinToGrid,
	PX_PER_MIN
} from './time.js';
import {
	buildStageOrder,
	collectLikedPerformances,
	fetchTimetableForRoom,
	groupPerformancesByStage
} from './timetable.js';
import type {
	ParticipantMark,
	Performance,
	RoomSelection,
	SelectionMap,
	SelectionState,
	Timetable,
	ViewMode
} from './types.js';

/** Shown before the first timetable ever loads. */
const EMPTY_TIMETABLE: Timetable = { festival: '', days: [] };

/** How often the room re-reads everyone else's picks. */
const POLL_INTERVAL_MS = 10_000;
/** Local edits are coalesced for this long before being written. */
const PUT_DEBOUNCE_MS = 500;
/** How often the "now" line is repositioned. */
const NOW_TICK_MS = 60_000;
/** How long the "Copied!" confirmation stays up. */
const COPIED_FEEDBACK_MS = 2000;

/** An action a signed-out browser attempted, replayed once they have a room. */
export interface PendingGuestAction {
	type: 'perf' | 'like';
	performanceId: string;
}

export interface RoomStateDeps {
	/** Navigate to an app route. */
	navigate: (url: string) => void;
}

export class RoomState {
	#deps: RoomStateDeps;

	/**
	 * Incremented on every bootstrap. Async steps compare against it before writing
	 * state, so a fast room switch can't be overwritten by the previous room's
	 * in-flight response.
	 */
	#bootstrapToken = 0;
	#putTimer: ReturnType<typeof setTimeout> | null = null;
	#pollTimer: ReturnType<typeof setInterval> | null = null;
	#nowTimer: ReturnType<typeof setInterval> | null = null;
	#copiedTimer: ReturnType<typeof setTimeout> | null = null;
	/** True when a local edit has not yet been written to the backend. */
	#hasPendingWrite = false;
	/**
	 * Set once the page is torn down. Bootstrapping is async, so a room can be left
	 * while its first load is still in flight; without this, the load would resume and
	 * start a polling loop nothing will ever stop.
	 */
	#disposed = false;
	/**
	 * Incremented per save. A save that finishes after a newer one started must not
	 * report its outcome — otherwise a slow success can clear the error a later,
	 * failed save just raised.
	 */
	#writeSeq = 0;

	// ---- Identity ----
	roomId = $state('');
	userId = $state('');
	myName = $state('');
	myColor = $state(DEFAULT_COLOR);
	googleIdToken = $state('');
	/** Whether a Google identity exists site-wide, used to offer sign-in while browsing. */
	hasGlobalAuth = $state(false);

	// ---- Room data ----
	mySelections = $state<SelectionMap>({});
	allSelections = $state<RoomSelection[]>([]);
	likedIds = $state<ReadonlySet<string>>(new Set());
	/** Null shows every participant; an empty array shows only the viewer. */
	selectedOtherUserIds = $state<string[] | null>(null);

	// ---- View ----
	currentDayIdx = $state(0);
	viewMode = $state<ViewMode>('full');
	/**
	 * Wall-clock minutes since midnight, or -1 before the first tick. Stored raw and
	 * projected in {@link nowMin}, so switching to a festival whose grid starts at a
	 * different hour re-places the line without waiting for the next tick.
	 */
	nowClockMin = $state(-1);

	// ---- Status ----
	/**
	 * Read and write failures are tracked apart, so a save that lands late cannot
	 * clear an error the other half of the sync loop just raised.
	 */
	readError = $state('');
	writeError = $state('');
	copied = $state(false);

	// ---- Dialogs ----
	joinModalOpen = $state(false);
	joinName = $state('');
	joinColor = $state(DEFAULT_COLOR);
	leaveDialogOpen = $state(false);
	leavingRoom = $state(false);
	leaveError = $state('');
	reauthRequired = $state(false);
	guestSigninOpen = $state(false);
	googleAuthError = $state('');
	creatingGuestRoom = $state(false);
	pendingGuestAction = $state<PendingGuestAction | null>(null);
	detailsPerformance = $state<Performance | null>(null);
	detailsStageName = $state('');

	// ---- Timetable ----
	/** Fetched at runtime from `data/timetable-{festivalId}.json`; not bundled. */
	timetable = $state<Timetable>(EMPTY_TIMETABLE);
	timetableLoading = $state(true);
	timetableError = $state('');

	constructor(deps: RoomStateDeps) {
		this.#deps = deps;
	}

	// ---- Derived view model ----

	/** Browsing a festival lineup without a room: read-only until sign-in. */
	isGuestMode = $derived(isFestivalBrowseId(this.roomId));
	stageOrder = $derived(buildStageOrder(this.timetable));
	currentDay = $derived(this.timetable.days[this.currentDayIdx]);
	stagesForDay = $derived(groupPerformancesByStage(this.currentDay, this.stageOrder));

	otherParticipants = $derived(
		this.allSelections.filter((selection) => selection.userId !== this.userId)
	);
	filteredSelections = $derived(
		filterSelectionsByParticipantIds(this.allSelections, this.userId, this.selectedOtherUserIds)
	);
	visibleStages = $derived(
		this.viewMode === 'picks'
			? filterPicks(this.stagesForDay, this.filteredSelections)
			: this.stagesForDay
	);
	showingAllParticipants = $derived(this.selectedOtherUserIds === null);
	/** The message shown in the status bar; a failed save outranks a failed read. */
	syncError = $derived(this.writeError || this.readError);
	takenColors = $derived(takenColorsExcluding(this.allSelections, this.userId));
	likedPerformances = $derived(collectLikedPerformances(this.timetable, this.likedIds));

	gridStartMin = $derived(computeGridStart(this.timetable.days));
	gridEndMin = $derived(this.gridStartMin + GRID_SPAN_MIN);
	gridHeightPx = $derived(GRID_SPAN_MIN * PX_PER_MIN);
	hourMarkers = $derived(buildHourMarkers(this.gridStartMin));
	/** The current time on the grid axis, or -1 before the first tick. */
	nowMin = $derived(
		this.nowClockMin < 0 ? -1 : projectClockMinToGrid(this.nowClockMin, this.gridStartMin)
	);
	nowTopPx = $derived((this.nowMin - this.gridStartMin) * PX_PER_MIN);
	/**
	 * Index of the festival day happening right now, or -1 when the festival isn't running
	 * today. Recomputed each clock tick so a rollover past the day boundary moves the line.
	 */
	todayDayIdx = $derived.by(() => {
		void this.nowClockMin;
		return getCurrentDayIdx(this.timetable.days);
	});
	/** The now-line only belongs on the day currently in progress, and only while on-grid. */
	nowVisible = $derived(
		this.currentDayIdx === this.todayDayIdx &&
			this.nowMin >= this.gridStartMin &&
			this.nowMin < this.gridEndMin
	);

	statusMessage = $derived.by(() => {
		if (this.viewMode !== 'picks' || this.visibleStages.length > 0) return '';
		return Object.values(this.mySelections).some((state) => state > 0)
			? 'No picks yet — mark some performances first.'
			: 'After you mark performances, you can see them in your picks.';
	});

	/** Marks by everyone currently visible, for one performance. */
	participantMarks(performanceId: string): ParticipantMark[] {
		return getParticipantMarks(this.filteredSelections, performanceId);
	}

	/**
	 * Marks by everyone except the viewer — the badges drawn on a performance block,
	 * where the viewer's own mark is already conveyed by the block's colour.
	 */
	otherParticipantMarks(performanceId: string): ParticipantMark[] {
		return this.participantMarks(performanceId).filter((mark) => mark.userId !== this.userId);
	}

	/** The viewer's own mark on a performance. */
	myState(performanceId: string): SelectionState {
		return stateOf(this.mySelections, performanceId);
	}

	isLiked(performanceId: string): boolean {
		return this.likedIds.has(performanceId);
	}

	isParticipantSelected(participantId: string): boolean {
		return (
			participantId === this.userId ||
			this.selectedOtherUserIds === null ||
			this.selectedOtherUserIds.includes(participantId)
		);
	}

	// ---- Lifecycle ----

	/**
	 * Load a room: restore local hints, verify sign-in, fetch participants and decide
	 * whether the join modal is needed. Safe to call again when the route changes.
	 */
	async bootstrap(roomId: string): Promise<void> {
		const token = ++this.#bootstrapToken;
		this.#cancelPendingPut();
		this.stopPolling();

		this.roomId = roomId;
		this.likedIds = loadLikedIds(roomId);
		this.readError = '';
		this.writeError = '';

		// Every room-scoped field has to go, not just the ones reloaded below. Carrying
		// picks across a switch would make the previous room's selections the local
		// snapshot for this one — mergeSelectionsForViewer treats a non-empty viewer
		// entry as authoritative — and the next toggle would write them into this room.
		this.mySelections = {};
		this.allSelections = [];
		this.detailsPerformance = null;
		this.leaveDialogOpen = false;

		// Fetched alongside everything else below, not awaited on its own: the grid and
		// the participant list have nothing to do with each other, so there's no reason
		// to make the page wait for both in sequence.
		const timetableLoad = this.#loadTimetable(roomId, token);

		if (isFestivalBrowseId(roomId)) {
			this.#resetToGuestBrowsing();
			await timetableLoad;
			return;
		}

		this.creatingGuestRoom = false;
		this.hasGlobalAuth = true;
		this.selectedOtherUserIds = loadParticipantFilter(roomId);

		const globalAuth = loadGoogleAuth();
		if (!globalAuth) {
			this.#deps.navigate(`/?next=${encodeURIComponent(roomId)}`);
			await timetableLoad;
			return;
		}

		this.googleIdToken = globalAuth.idToken;
		this.userId = `google:${globalAuth.sub}`;

		const cached = loadRoomIdentity(roomId);
		this.myName = cached?.name ?? '';
		this.myColor = cached?.color ?? DEFAULT_COLOR;

		const [result] = await Promise.all([
			this.refresh({ preferRemoteColor: true }),
			timetableLoad
		]);
		if (token !== this.#bootstrapToken || this.#disposed) return;

		this.startPolling();

		if (result.remoteViewerFound) {
			const viewerEntry = this.allSelections.find((s) => s.userId === this.userId);
			this.myName = viewerEntry?.name || cached?.name || globalAuth.givenName || globalAuth.name;
			saveRoomIdentity(roomId, this.myName, this.myColor);
			this.joinModalOpen = false;
			return;
		}

		this.joinName = cached?.name || globalAuth.givenName || '';
		this.joinColor = firstAvailableColor(this.takenColors);
		this.joinModalOpen = true;
	}

	async #loadTimetable(roomId: string, token: number): Promise<void> {
		this.timetableLoading = true;
		this.timetableError = '';

		const result = await fetchTimetableForRoom(roomId);
		if (token !== this.#bootstrapToken || this.#disposed) return;

		this.timetableLoading = false;
		if (!result.ok) {
			this.timetableError = 'Could not load the timetable. Please try again.';
			return;
		}

		this.timetable = result.data;
		this.currentDayIdx = getInitialDayIdx(this.timetable.days);
	}

	/** Retry a failed timetable fetch without re-running the rest of bootstrap. */
	async retryTimetable(): Promise<void> {
		if (!this.roomId) return;
		await this.#loadTimetable(this.roomId, this.#bootstrapToken);
	}

	#resetToGuestBrowsing(): void {
		this.userId = '';
		this.googleIdToken = '';
		this.myName = '';
		this.allSelections = [];
		this.mySelections = {};
		this.selectedOtherUserIds = null;
		this.joinModalOpen = false;
		this.viewMode = 'full';
		this.hasGlobalAuth = Boolean(loadGoogleAuth());
	}

	/** Start the clock that positions the "now" line. */
	startClock(): void {
		if (this.#disposed) return;
		this.tickNow();
		this.#nowTimer ??= setInterval(() => this.tickNow(), NOW_TICK_MS);
	}

	tickNow(): void {
		this.nowClockMin = clockMinutes();
	}

	startPolling(): void {
		this.stopPolling();
		if (this.#disposed) return;
		this.#pollTimer = setInterval(() => {
			// Skip polling a room nobody is looking at; the next foreground tick catches up.
			if (typeof document !== 'undefined' && document.hidden) return;
			void this.refresh();
		}, POLL_INTERVAL_MS);
	}

	stopPolling(): void {
		if (this.#pollTimer) clearInterval(this.#pollTimer);
		this.#pollTimer = null;
	}

	/** Tear down every timer. Call from the component's onDestroy. */
	dispose(): void {
		this.#disposed = true;
		this.stopPolling();
		this.#cancelPendingPut();
		// Drop any unsaved edit with the instance: a later flush would write picks
		// into a room this viewer may have already left.
		this.#hasPendingWrite = false;
		if (this.#nowTimer) clearInterval(this.#nowTimer);
		this.#nowTimer = null;
		if (this.#copiedTimer) clearTimeout(this.#copiedTimer);
		this.#copiedTimer = null;
	}

	/**
	 * Write out any debounced edit immediately — used when the page is being hidden or
	 * unloaded, where waiting out the debounce would silently drop the last pick.
	 */
	flushPendingWrites(): void {
		if (!this.#hasPendingWrite || this.#disposed) return;
		this.#cancelPendingPut();
		void this.#writeSelections();
	}

	// ---- Sync ----

	/** Re-read the room from the backend and merge it with local edits. */
	async refresh(options: { preferRemoteColor?: boolean } = {}): Promise<{
		remoteViewerFound: boolean;
	}> {
		const roomId = this.roomId;
		const userId = this.userId;
		if (!roomId || !userId) {
			return { remoteViewerFound: false };
		}

		const result = await fetchRoomSelections(roomId);
		// The viewer moved rooms (or signed out) while this was in flight; applying it
		// now would hydrate one room's picks into another.
		if (roomId !== this.roomId || userId !== this.userId) {
			return { remoteViewerFound: false };
		}
		if (!result.ok) {
			this.readError = 'Sync failed. Retrying…';
			return { remoteViewerFound: false };
		}

		const merged = mergeSelectionsForViewer(
			result.data,
			{
				userId: this.userId,
				name: this.myName,
				color: this.myColor,
				selections: this.mySelections
			},
			{ preferRemoteColor: options.preferRemoteColor }
		);

		this.mySelections = merged.viewerSelections;
		this.myColor = merged.viewerColor;
		this.allSelections = merged.allSelections;
		this.#reconcileParticipantFilter();
		this.readError = '';
		return { remoteViewerFound: merged.remoteViewerFound };
	}

	#schedulePut(): void {
		this.#hasPendingWrite = true;
		if (this.#putTimer) clearTimeout(this.#putTimer);
		this.#putTimer = setTimeout(() => {
			this.#putTimer = null;
			void this.#writeSelections();
		}, PUT_DEBOUNCE_MS);
	}

	#cancelPendingPut(): void {
		if (this.#putTimer) clearTimeout(this.#putTimer);
		this.#putTimer = null;
	}

	async #writeSelections(): Promise<void> {
		if (!this.roomId || !this.userId || !this.myName) {
			return;
		}

		const seq = ++this.#writeSeq;
		const result = await putRoomSelections(this.roomId, {
			googleIdToken: this.googleIdToken,
			name: this.myName,
			color: this.myColor,
			selections: this.mySelections
		});
		if (seq !== this.#writeSeq) return;

		if (result.ok) {
			// An edit made while this request was in flight has its own debounce timer
			// still owing a write. Clearing the flag here would make flushPendingWrites()
			// a no-op, and a page frozen on backgrounding would drop that edit.
			if (!this.#putTimer) this.#hasPendingWrite = false;
			this.writeError = '';
			return;
		}
		if (result.unauthorized) {
			this.#handleGoogleSessionExpired();
			return;
		}
		this.writeError = 'Save failed.';
	}

	#reconcileParticipantFilter(): void {
		const availableOtherUserIds = this.otherParticipants.map((selection) => selection.userId);
		const normalized = normalizeSelectedOtherUserIds(
			this.selectedOtherUserIds,
			availableOtherUserIds
		);
		const unchanged =
			normalized === null
				? this.selectedOtherUserIds === null
				: JSON.stringify(normalized) === JSON.stringify(this.selectedOtherUserIds ?? []);
		if (unchanged) return;

		this.selectedOtherUserIds = normalized;
		if (this.roomId) saveParticipantFilter(this.roomId, normalized);
	}

	/**
	 * Rare path: the cached Google ID token was rejected (expired/invalid). Re-prompt for
	 * Google sign-in in place, without touching name/colour/selections, so the user resumes
	 * exactly where they were instead of being sent back through the join flow.
	 */
	#handleGoogleSessionExpired(): void {
		this.reauthRequired = true;
		this.googleAuthError = 'Your Google session expired.';
		this.writeError = 'Save failed — signed out of Google.';
	}

	// ---- Picks ----

	/** Cycle a performance between unmarked → going → maybe. */
	togglePerformance(performanceId: string): void {
		if (this.joinModalOpen) return;
		if (this.isGuestMode) {
			this.requestGuestAction('perf', performanceId);
			return;
		}

		const next = cycleState(this.myState(performanceId));
		haptic();
		this.mySelections = { ...this.mySelections, [performanceId]: next };
		this.allSelections = this.allSelections.map((selection) =>
			selection.userId === this.userId
				? { ...selection, selections: this.mySelections }
				: selection
		);
		this.#schedulePut();
	}

	toggleLiked(performanceId: string): void {
		if (this.isGuestMode) {
			this.requestGuestAction('like', performanceId);
			return;
		}
		const next = new Set(this.likedIds);
		if (next.has(performanceId)) next.delete(performanceId);
		else next.add(performanceId);
		this.likedIds = next;
		saveLikedIds(this.roomId, next);
		haptic();
	}

	// ---- Day / view navigation ----

	selectDay(index: number): void {
		this.currentDayIdx = index;
	}

	/** Move one day forward (+1) or back (-1), wrapping at the ends. */
	stepDay(delta: number): void {
		const dayCount = this.timetable.days.length;
		if (dayCount === 0) return;
		this.currentDayIdx = (this.currentDayIdx + delta + dayCount) % dayCount;
		haptic();
	}

	setViewMode(mode: ViewMode): void {
		this.viewMode = mode;
	}

	resetParticipantFilter(): void {
		this.selectedOtherUserIds = null;
		saveParticipantFilter(this.roomId, null);
	}

	toggleParticipantFilter(participantId: string): void {
		if (participantId === this.userId) return;

		const availableOtherUserIds = this.otherParticipants.map((selection) => selection.userId);
		const nextSelection = this.selectedOtherUserIds
			? [...this.selectedOtherUserIds]
			: [...availableOtherUserIds];
		const index = nextSelection.indexOf(participantId);
		if (index >= 0) nextSelection.splice(index, 1);
		else nextSelection.push(participantId);

		this.selectedOtherUserIds = normalizeSelectedOtherUserIds(
			nextSelection,
			availableOtherUserIds
		);
		saveParticipantFilter(this.roomId, this.selectedOtherUserIds);
	}

	// ---- Artist details ----

	openDetails(performance: Performance, stageName: string): void {
		if (this.joinModalOpen) return;
		this.detailsPerformance = performance;
		this.detailsStageName = stageName;
		// A history entry means the phone back gesture closes the card instead of the room.
		if (typeof history !== 'undefined') {
			history.pushState({ stagehopperDetails: true }, '');
		}
	}

	closeDetails(): void {
		if (typeof history !== 'undefined' && history.state?.stagehopperDetails) {
			history.back();
			return;
		}
		this.detailsPerformance = null;
	}

	/** The browser went back past the details card's history entry. */
	handlePopState(): void {
		this.detailsPerformance = null;
	}

	// ---- Joining ----

	selectJoinColor(color: string): void {
		if (this.takenColors.has(color)) return;
		this.joinColor = color;
	}

	confirmJoin(): void {
		const trimmedName = truncateName(this.joinName);
		if (!trimmedName) return;

		this.myName = trimmedName;
		this.myColor = this.joinColor;
		this.mySelections = {};
		saveRoomIdentity(this.roomId, trimmedName, this.joinColor);
		this.allSelections = [
			...this.allSelections.filter((s) => s.userId !== this.userId),
			{ userId: this.userId, name: trimmedName, color: this.joinColor, selections: {} }
		];
		this.#reconcileParticipantFilter();
		this.joinModalOpen = false;

		const action = this.pendingGuestAction;
		this.pendingGuestAction = null;
		this.creatingGuestRoom = false;

		if (action?.type === 'perf') {
			this.togglePerformance(action.performanceId);
			return;
		}
		if (action?.type === 'like') {
			this.toggleLiked(action.performanceId);
		}
		void this.#writeSelections();
	}

	// ---- Guest sign-in ----

	/** A signed-out browser tried to mark something: sign in, then replay the action. */
	requestGuestAction(type: PendingGuestAction['type'], performanceId: string): void {
		if (this.creatingGuestRoom) return;
		this.pendingGuestAction = { type, performanceId };
		if (loadGoogleAuth()) {
			void this.createGuestRoomAndNavigate();
			return;
		}
		this.guestSigninOpen = true;
		this.googleAuthError = '';
	}

	/** Sign-in offered from the menu rather than triggered by a gated tap. */
	openGuestSignin(): void {
		this.pendingGuestAction = null;
		this.guestSigninOpen = true;
		this.googleAuthError = '';
	}

	cancelGuestSignin(): void {
		this.guestSigninOpen = false;
		this.pendingGuestAction = null;
	}

	handleGuestCredential(response: GoogleCredentialResponse): void {
		const idToken = response?.credential ?? '';
		const claims = parseGoogleIdTokenClaims(idToken);
		if (!idToken || !claims) {
			this.googleAuthError = 'Google sign-in failed. Please try again.';
			return;
		}

		saveGoogleAuth({
			idToken,
			sub: claims.sub,
			name: claims.name,
			givenName: claims.givenName
		});
		this.googleIdToken = idToken;
		this.userId = `google:${claims.sub}`;
		this.hasGlobalAuth = true;
		this.googleAuthError = '';
		this.guestSigninOpen = false;

		if (this.pendingGuestAction) {
			void this.createGuestRoomAndNavigate();
		}
	}

	async createGuestRoomAndNavigate(): Promise<void> {
		if (this.creatingGuestRoom) return;
		this.creatingGuestRoom = true;

		const festival = getFestivalById(this.roomId);
		if (!festival) {
			this.#failGuestRoomCreation();
			return;
		}

		const newRoomId = generateRoomId(festival.prefix);
		const result = await createRoom(newRoomId);
		if (!result.ok) {
			this.#failGuestRoomCreation();
			return;
		}
		this.#deps.navigate(roomPath(newRoomId));
	}

	#failGuestRoomCreation(): void {
		this.writeError = 'Could not start a room. Please try again.';
		this.pendingGuestAction = null;
		this.creatingGuestRoom = false;
	}

	// ---- Re-authentication ----

	handleReauthCredential(response: GoogleCredentialResponse): void {
		const idToken = response?.credential ?? '';
		const claims = parseGoogleIdTokenClaims(idToken);
		if (!idToken || !claims || `google:${claims.sub}` !== this.userId) {
			this.googleAuthError = 'Please sign in with the same Google account.';
			return;
		}

		this.googleIdToken = idToken;
		saveGoogleAuth({
			idToken,
			sub: claims.sub,
			name: claims.name,
			givenName: claims.givenName
		});
		this.reauthRequired = false;
		this.googleAuthError = '';
		this.writeError = '';
		void this.#writeSelections();
	}

	// ---- Leaving / sharing / sign-out ----

	openLeaveDialog(): void {
		this.leaveError = '';
		this.leaveDialogOpen = true;
	}

	cancelLeaveDialog(): void {
		this.leaveDialogOpen = false;
		this.leaveError = '';
	}

	async confirmLeaveRoom(): Promise<void> {
		this.leavingRoom = true;
		this.leaveError = '';
		this.#cancelPendingPut();
		// Anything unsaved dies with the membership; flushing it later would re-create
		// the rows this call is about to delete.
		this.#hasPendingWrite = false;

		const result = await leaveRoomRequest(this.roomId, this.googleIdToken);
		if (!result.ok) {
			this.leaveError = 'Could not leave the room. Please try again.';
			this.leavingRoom = false;
			return;
		}

		this.leavingRoom = false;
		this.leaveDialogOpen = false;
		this.#deps.navigate('/');
	}

	signOut(): void {
		clearGoogleAuth();
		this.#deps.navigate('/');
	}

	/** Share the room via the native share sheet, falling back to the clipboard. */
	async share(): Promise<void> {
		if (typeof window === 'undefined') return;
		const url = window.location.href;
		const festival = getFestivalById(this.roomId) ?? getFestivalByPrefix(this.roomId);

		if (navigator.share) {
			try {
				await navigator.share({
					title: festival?.name ?? 'StageHopper',
					text: this.isGuestMode
						? 'Check out this StageHopper festival lineup'
						: 'Join my StageHopper room',
					url
				});
				return;
			} catch (error) {
				// The user dismissing the share sheet is not a failure worth falling back
				// on. Checked structurally: this rejects with a DOMException, not an Error.
				if ((error as { name?: string } | null)?.name === 'AbortError') return;
			}
		}

		try {
			await navigator.clipboard.writeText(url);
			this.copied = true;
			if (this.#copiedTimer) clearTimeout(this.#copiedTimer);
			this.#copiedTimer = setTimeout(() => (this.copied = false), COPIED_FEEDBACK_MS);
		} catch {
			// No clipboard access — nothing useful to report.
		}
	}
}
