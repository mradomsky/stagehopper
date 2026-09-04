/**
 * @file All room-page state and behaviour, as a rune class.
 *
 * The page component renders this; it owns no logic of its own. Navigation is
 * injected so the class can be driven in tests without SvelteKit.
 */

import {
	createRoom,
	fetchRoomSelections,
	getNotificationSettings,
	leaveRoom as leaveRoomRequest,
	putRoomSelections,
	saveNotificationOverride,
	type NotificationSettings
} from './api.js';
import { auth, loadAuth, signOut as endSession } from './auth.svelte.js';
import {
	getFestivalById,
	getFestivalByPrefix,
	getLatestFestival,
	isFestivalBrowseId
} from './festivals.svelte.js';
import { maybeOpenInstallPromo } from './install.js';
import { haptic } from './haptics.js';
import { effectiveNotify, groupPicksByDay, timingOf } from './picks.js';
import { extractRoomDisplayName, generateRoomId, roomPath } from './rooms.js';
import { entryScrollTargetId, groupScheduleByDay } from './schedule-list.js';
import {
	DEFAULT_COLOR,
	cycleState,
	firstAvailableColor,
	getParticipantMarks,
	mergeSelectionsForViewer,
	stateOf,
	takenColorsExcluding,
	truncateName
} from './selections.js';
import {
	clearAllRoomSnapshots,
	clearRoomSnapshots,
	loadAllSnapshot,
	loadFavouriteStages,
	loadMySnapshot,
	loadRoomIdentity,
	loadTimetableLayout,
	saveAllSnapshot,
	saveFavouriteStages,
	saveMySnapshot,
	saveRoomIdentity,
	saveTimetableLayout
} from './storage.js';
import {
	buildHourMarkers,
	clockMinutes,
	computeDayGridRange,
	getCurrentDayIdx,
	getInitialDayIdx,
	projectClockMinToGrid,
	PX_PER_MIN
} from './time.js';
import {
	fetchTimetableForRoom,
	groupPerformancesByStage,
	orderStagesByFavourite,
	resolveStageOrder
} from './timetable.js';
import type {
	ParticipantMark,
	Performance,
	RoomSelection,
	SelectionMap,
	SelectionState,
	Timetable,
	TimetableLayout,
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
	type: 'perf';
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
	/**
	 * Count of consecutive failed refreshes. Read errors only show after 2 failures,
	 * so a single poll hiccup doesn't strobe the banner.
	 */
	#consecutiveReadFailures = 0;

	// ---- Identity ----
	roomId = $state('');
	userId = $state('');
	myName = $state('');
	myColor = $state(DEFAULT_COLOR);
	/** Whether someone is signed in site-wide, used to offer sign-in while browsing. */
	hasGlobalAuth = $state(false);

	// ---- Room data ----
	mySelections = $state<SelectionMap>({});
	/** Everyone else's picks, as last read from the server or restored from the snapshot. */
	otherSelections = $state<RoomSelection[]>([]);
	/** This room's custom display name, if the creator set one — see extractRoomDisplayName. */
	roomDisplayName = $state<string | null>(null);
	/** Stage names the viewer floated to the front of the grid; local to this device. */
	favouriteStages = $state<ReadonlySet<string>>(new Set());
	/**
	 * Push notification settings, shared by the Picks tab's bells, the details card's
	 * bell and the Notifications dialog. Null until the first fetch resolves (lazily, on
	 * first opening the Picks tab or a details card — see
	 * {@link ensureNotificationSettingsLoaded}). The dialog updates this directly on
	 * load/save so the surfaces never disagree.
	 */
	notificationSettings = $state<NotificationSettings | null>(null);
	#notificationSettingsRequested = false;
	/** Guards a bell write against a stale response landing after a newer toggle. */
	#notifyWriteSeq = 0;

	// ---- View ----
	currentDayIdx = $state(0);
	viewMode = $state<ViewMode>('full');
	/**
	 * A performance deep-linked via `#perf-{id}` (e.g. tapped from a push notification). Both
	 * timetable layouts briefly highlight it; the room page clears this after the flash. Null
	 * when nothing is being spotlighted.
	 */
	highlightedPerfId = $state<string | null>(null);
	/**
	 * How the Timetable panel draws the schedule. A viewer-level preference rather than a
	 * room one, so it is read from (and written back to) storage rather than reset per room.
	 */
	timetableLayout = $state<TimetableLayout>(loadTimetableLayout());
	/**
	 * The moment the time-dependent derivations read, advanced by {@link tickNow}. Null until
	 * the first tick.
	 *
	 * The instant itself, not the minute-of-day it used to hold: three derivations need the
	 * whole Date, so each called `new Date()` itself and then faked a dependency on the stored
	 * scalar with `void this.nowClockMin` to stay reactive. That let them observe three
	 * different instants — across a midnight or the 09:00 day boundary, three different days —
	 * and every helper they call already accepts the instant as a parameter. Stored rather
	 * than derived from a tick counter so switching to a festival whose grid starts at a
	 * different hour re-places the line without waiting for the next tick.
	 */
	now = $state<Date | null>(null);
	/** The instant every derivation below shares, so none of them can disagree with another. */
	nowInstant = $derived(this.now ?? new Date());

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
	signInError = $state('');
	creatingGuestRoom = $state(false);
	pendingGuestAction = $state<PendingGuestAction | null>(null);
	detailsPerformance = $state<Performance | null>(null);
	mapOpen = $state(false);

	// ---- Timetable ----
	/** Fetched at runtime from `data/festivals/{festivalId}/timetable.json`; not bundled. */
	timetable = $state<Timetable>(EMPTY_TIMETABLE);
	timetableLoading = $state(true);
	timetableError = $state('');

	constructor(deps: RoomStateDeps) {
		this.#deps = deps;
	}

	// ---- Derived view model ----

	/** Browsing a festival lineup without a room: read-only until sign-in. */
	isGuestMode = $derived(isFestivalBrowseId(this.roomId));
	stageOrder = $derived(
		orderStagesByFavourite(
			resolveStageOrder(this.timetable, this.festivalStageOrder),
			this.favouriteStages
		)
	);
	currentDay = $derived(this.timetable.days[this.currentDayIdx]);
	stagesForDay = $derived(groupPerformancesByStage(this.currentDay, this.stageOrder));

	/** The message shown in the status bar; a failed save outranks a failed read. */
	syncError = $derived(this.writeError || this.readError);
	/**
	 * Everyone in the room, the viewer included, folded together from the fields that own each
	 * part. Derived rather than stored: it used to be kept in step by hand, so a toggle re-mapped
	 * the viewer's entry into it, joining rebuilt it, and three readers filtered the viewer back
	 * out of it — a fold and three unfolds of the same one fact.
	 */
	allSelections: RoomSelection[] = $derived([
		...this.otherSelections,
		{
			userId: this.userId,
			name: this.myName,
			color: this.myColor,
			selections: this.mySelections
		}
	]);
	takenColors = $derived(takenColorsExcluding(this.allSelections, this.userId));

	gridRange = $derived(computeDayGridRange(this.currentDay));
	gridStartMin = $derived(this.gridRange.start);
	gridEndMin = $derived(this.gridRange.end);
	gridHeightPx = $derived((this.gridEndMin - this.gridStartMin) * PX_PER_MIN);
	hourMarkers = $derived(buildHourMarkers(this.gridStartMin, this.gridEndMin));
	/** The current time on the grid axis, or -1 before the first tick. */
	nowMin = $derived(
		this.now === null ? -1 : projectClockMinToGrid(clockMinutes(this.now), this.gridStartMin)
	);
	nowTopPx = $derived((this.nowMin - this.gridStartMin) * PX_PER_MIN);
	/**
	 * Index of the festival day happening right now, or -1 when the festival isn't running
	 * today. Recomputed each clock tick so a rollover past the day boundary moves the line.
	 */
	todayDayIdx = $derived(getCurrentDayIdx(this.timetable.days, this.nowInstant));
	/** The now-line only belongs on the day currently in progress, and only while on-grid. */
	nowVisible = $derived(
		this.currentDayIdx === this.todayDayIdx &&
			this.nowMin >= this.gridStartMin &&
			this.nowMin < this.gridEndMin
	);
	/** Date of the festival day currently in progress, for the Picks list's TODAY badge. */
	todayDate = $derived(this.timetable.days[this.todayDayIdx]?.date ?? null);
	/**
	 * Marked performances grouped by day for the Picks tab, each tagged with how it
	 * relates to the current moment. Recomputed each clock tick, same as {@link todayDayIdx}.
	 */
	pickGroups = $derived.by(() => {
		const now = this.nowInstant;
		return groupPicksByDay(this.timetable, this.mySelections).map((group) => ({
			date: group.date,
			label: group.label,
			performances: group.performances.map((performance) => ({
				performance,
				timing: timingOf(group.date, performance, now)
			}))
		}));
	});
	/**
	 * The pick to centre the list on when the tab opens: the first one not yet ended.
	 * Reads off {@link pickGroups} rather than recomputing — the timing classification
	 * it needs is already sitting there.
	 */
	pickScrollTargetId = $derived.by(() => {
		for (const group of this.pickGroups) {
			for (const row of group.performances) {
				if (row.timing !== 'past') return row.performance.id;
			}
		}
		return null;
	});
	/**
	 * The whole schedule, day by day, for the timetable's list layout. Unlike
	 * {@link pickGroups} nothing is filtered out — including days with no sets, which the
	 * list still renders so its day headers line up with the day tabs. Recomputed each
	 * clock tick, same as {@link pickGroups}.
	 */
	scheduleGroups = $derived(
		groupScheduleByDay(this.timetable, this.stageOrder, this.nowInstant)
	);
	/** The row the list layout anchors on when it opens; null to sit at the day's header. */
	scheduleScrollTargetId = $derived(
		entryScrollTargetId(this.scheduleGroups, this.currentDayIdx, this.todayDate)
	);

	/** Whether push is on for this account on any device — the bell's muted/live state. */
	notificationsAvailable = $derived(this.notificationSettings?.enabled ?? false);
	/** The "maybe" default; overridden per-performance by {@link notifyStateOf}. */
	notifyMaybeSetting = $derived(this.notificationSettings?.notifyMaybe ?? false);
	notifyOverrides = $derived(this.notificationSettings?.notifyOverrides ?? {});

	/** The festival's map URL, or null if no map is available. */
	get mapUrl(): string | null {
		const f = getFestivalById(this.roomId) ?? getFestivalByPrefix(this.roomId);
		return f?.mapUrl ?? null;
	}

	/** Stage name → `#rrggbb` colour, admin-set per stage. */
	get stageColors(): Record<string, string> | undefined {
		const f = getFestivalById(this.roomId) ?? getFestivalByPrefix(this.roomId);
		return f?.stageColors;
	}

	/**
	 * The festival this room’s picks belong to, resolved exactly as the timetable itself is
	 * (`fetchTimetableForRoom`): by id, then by prefix, then the latest festival. Sent on
	 * every write so the backend can index the room for the timetable re-import gate.
	 *
	 * The last fallback is the point of it. A custom-slug room has no prefix to read a
	 * festival off, so this is the only thing that can tell the gate the room exists at all
	 * — and it names the festival whose timetable these picks were actually made against,
	 * which is the one whose re-import would orphan them.
	 */
	get festivalId(): string | null {
		try {
			return (
				getFestivalById(this.roomId)?.id ??
				getFestivalByPrefix(this.roomId)?.id ??
				getLatestFestival().id
			);
		} catch {
			// getLatestFestival throws on an empty list; no festival is a fine answer here.
			return null;
		}
	}

	/** The festival's admin-set stage display order, if any — see {@link resolveStageOrder}. */
	get festivalStageOrder(): string[] | undefined {
		const f = getFestivalById(this.roomId) ?? getFestivalByPrefix(this.roomId);
		return f?.stageOrder;
	}

	/** Marks by everyone currently visible, for one performance. */
	participantMarks(performanceId: string): ParticipantMark[] {
		return getParticipantMarks(this.allSelections, performanceId);
	}

	/**
	 * Marks by everyone except the viewer — the badges drawn on a performance block,
	 * where the viewer's own mark is already conveyed by the block's colour.
	 */
	otherParticipantMarks(performanceId: string): ParticipantMark[] {
		return getParticipantMarks(this.otherSelections, performanceId);
	}

	/** The viewer's own mark on a performance. */
	myState(performanceId: string): SelectionState {
		return stateOf(this.mySelections, performanceId);
	}

	/**
	 * Whether a pick would trigger a push notification — the Picks-list bell's state.
	 *
	 * Reads only this room's mark. The notifier itself aggregates a performance across
	 * every room the user has joined (going in any of them is enough to notify), so a
	 * performance marked differently across two rooms for the same festival can have the
	 * bell disagree with what actually fires. Accepted as a rare edge case — fixing it
	 * would mean fetching the user's marks across all their rooms just for this bell.
	 */
	notifyStateOf(performanceId: string): boolean {
		return effectiveNotify(
			this.myState(performanceId),
			this.notifyMaybeSetting,
			this.notifyOverrides[performanceId]
		);
	}

	// ---- Lifecycle ----

	/**
	 * Drop everything scoped to the room being left, before the next one loads.
	 *
	 * One place, listing every field, because the alternative is what this used to be: a
	 * per-feature list that said "every room-scoped field has to go" while clearing ten of
	 * them. Anything holding an id from the old room is the dangerous kind — a queued guest
	 * action replays a performance id that the new room's timetable may not contain, and an
	 * open map belongs to the festival just left.
	 *
	 * Deliberately not here: favouriteStages and the timetable are reloaded for the new room
	 * by the caller; timetableLayout and hasGlobalAuth are viewer-level, not room-level.
	 */
	#clearRoomScopedState(): void {
		// Carrying picks across a switch would make the previous room's selections the local
		// snapshot for this one — mergeSelectionsForViewer treats a non-empty viewer entry as
		// authoritative — and the next toggle would write them into this room.
		this.mySelections = {};
		this.otherSelections = [];
		this.roomDisplayName = null;

		// Overlays and dialogs, all of which belong to the room being left.
		this.detailsPerformance = null;
		this.mapOpen = false;
		this.leaveDialogOpen = false;
		this.leavingRoom = false;
		this.leaveError = '';
		this.guestSigninOpen = false;
		this.signInError = '';
		this.reauthRequired = false;
		this.copied = false;

		// Both carry a performance id from the old room's timetable.
		this.pendingGuestAction = null;
		this.highlightedPerfId = null;

		// Refetched below, scoped to whichever identity is current now.
		this.notificationSettings = null;
		this.#notificationSettingsRequested = false;
	}

	/**
	 * Load a room: restore local hints, verify sign-in, fetch participants and decide
	 * whether the join modal is needed. Safe to call again when the route changes.
	 */
	async bootstrap(roomId: string): Promise<void> {
		const token = ++this.#bootstrapToken;
		this.#cancelPendingPut();
		this.stopPolling();

		this.roomId = roomId;
		this.favouriteStages = loadFavouriteStages(roomId);
		this.readError = '';
		this.writeError = '';

		this.#clearRoomScopedState();

		// Fetched alongside everything else below, not awaited on its own: the grid and
		// the participant list have nothing to do with each other, so there's no reason
		// to make the page wait for both in sequence.
		const timetableLoad = this.#loadTimetable(roomId, token);

		// Before any branch below reads it: both the browse path and the room path need to
		// know whether anyone is signed in, and Clerk resolves that asynchronously.
		await loadAuth();

		if (isFestivalBrowseId(roomId)) {
			this.#resetToGuestBrowsing();
			await timetableLoad;
			return;
		}

		this.creatingGuestRoom = false;
		this.hasGlobalAuth = true;

		const user = auth.user;
		if (!user) {
			this.#deps.navigate(`/?next=${encodeURIComponent(roomId)}`);
			await timetableLoad;
			return;
		}

		this.userId = `clerk:${user.id}`;
		// The timetable grid's per-set bells need this too now, not just the Picks tab —
		// no reason left to defer it until Picks is opened.
		this.ensureNotificationSettingsLoaded();

		const cached = loadRoomIdentity(roomId);
		this.myName = cached?.name ?? '';
		this.myColor = cached?.color ?? DEFAULT_COLOR;

		// Restore pending local edits from the last session if they haven't synced yet.
		const mySnap = loadMySnapshot(roomId);
		if (mySnap?.pendingWrite) {
			this.mySelections = mySnap.selections;
			this.#hasPendingWrite = true;
		}

		const [result] = await Promise.all([
			this.refresh({ preferRemoteColor: true }),
			timetableLoad
		]);
		if (token !== this.#bootstrapToken || this.#disposed) return;

		// Has the viewer already joined this room? The refresh normally answers it; when the
		// read failed, the offline snapshot below answers it instead.
		let knownMember = result.remoteViewerFound;

		// If the refresh failed on the network, hydrate others' picks from the snapshot
		// to avoid showing a blank room. My picks stay as seeded (either from the pending
		// snapshot or empty); the merge operation below handles pinning my local ones.
		if (result.readFailed) {
			const allSnap = loadAllSnapshot(roomId);
			if (allSnap) {
				const merged = mergeSelectionsForViewer(
					allSnap,
					{
						userId: this.userId,
						name: this.myName,
						color: this.myColor,
						selections: this.mySelections
					},
					{ preferRemoteColor: true }
				);
				this.otherSelections = merged.otherSelections;
				this.myColor = merged.viewerColor;
				// The snapshot answers "has this viewer already joined?" just as well as the network
				// would have. Without this the join modal opens on any read hiccup, and confirming it
				// below overwrites the very picks this branch just restored.
				knownMember = merged.remoteViewerFound;
			}
		}

		this.startPolling();

		if (knownMember) {
			// refresh() has already adopted the server's name for the viewer when there was one.
			this.myName = this.myName || cached?.name || user.givenName || user.name;
			saveRoomIdentity(roomId, this.myName, this.myColor);
			this.joinModalOpen = false;
			return;
		}

		this.joinName = cached?.name || user.givenName || '';
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
		this.myName = '';
		this.otherSelections = [];
		this.mySelections = {};
		this.joinModalOpen = false;
		this.viewMode = 'full';
		this.hasGlobalAuth = Boolean(auth.user);
	}

	/** Start the clock that positions the "now" line. */
	startClock(): void {
		if (this.#disposed) return;
		this.tickNow();
		this.#nowTimer ??= setInterval(() => this.tickNow(), NOW_TICK_MS);
	}

	tickNow(): void {
		this.now = new Date();
	}

	startPolling(): void {
		this.stopPolling();
		if (this.#disposed) return;
		this.#pollTimer = setInterval(() => {
			// Skip polling a room nobody is looking at; the next foreground tick catches up.
			if (typeof document !== 'undefined' && document.hidden) return;
			// Retry a failed write on the polling tick if no newer write is pending.
			if (this.#hasPendingWrite && !this.#putTimer) {
				void this.#writeSelections();
			}
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
		readFailed: boolean;
	}> {
		const roomId = this.roomId;
		const userId = this.userId;
		if (!roomId || !userId) {
			return { remoteViewerFound: false, readFailed: false };
		}

		const result = await fetchRoomSelections(roomId);
		// The viewer moved rooms (or signed out) while this was in flight; applying it
		// now would hydrate one room's picks into another.
		if (roomId !== this.roomId || userId !== this.userId) {
			return { remoteViewerFound: false, readFailed: false };
		}
		if (!result.ok) {
			this.#consecutiveReadFailures++;
			// Debounce: only show read error after 2 consecutive failures.
			if (this.#consecutiveReadFailures >= 2) {
				const isOffline =
					typeof navigator !== 'undefined' && navigator.onLine === false;
				this.readError = isOffline
					? 'Weak connection — showing your last synced picks.'
					: "Couldn't reach the server — retrying…";
			}
			return { remoteViewerFound: false, readFailed: true };
		}

		this.#consecutiveReadFailures = 0;
		const { participants, displayName } = extractRoomDisplayName(result.data);
		if (displayName) this.roomDisplayName = displayName;
		const merged = mergeSelectionsForViewer(
			participants,
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
		this.myName = merged.viewerName;
		this.otherSelections = merged.otherSelections;
		// Save a snapshot of everyone's picks for offline fallback.
		saveAllSnapshot(this.roomId, this.allSelections);
		this.readError = '';
		return { remoteViewerFound: merged.remoteViewerFound, readFailed: false };
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
		const festivalId = this.festivalId;
		const result = await putRoomSelections(this.roomId, {
			name: this.myName,
			color: this.myColor,
			selections: this.mySelections,
			...(festivalId ? { festivalId } : {})
		});
		if (seq !== this.#writeSeq) return;

		if (result.ok) {
			// An edit made while this request was in flight has its own debounce timer
			// still owing a write. Clearing the flag here would make flushPendingWrites()
			// a no-op, and a page frozen on backgrounding would drop that edit.
			if (!this.#putTimer) {
				this.#hasPendingWrite = false;
				// Mark the snapshot as synced (pendingWrite=false) now that the write succeeded.
				saveMySnapshot(this.roomId, this.mySelections, false);
			}
			this.writeError = '';
			return;
		}
		if (result.unauthorized) {
			this.#handleSessionExpired();
			return;
		}
		const isOffline =
			typeof navigator !== 'undefined' && navigator.onLine === false;
		this.writeError = isOffline
			? "Weak connection — your picks will sync when you're back."
			: "Couldn't save — retrying…";
	}

/**
	 * Rare path: the gateway rejected the request. Clerk refreshes its own tokens, so a 401
	 * means the session itself is gone rather than merely stale. Re-prompt in place, without
	 * touching name/colour/selections, so the user resumes exactly where they were instead
	 * of being sent back through the join flow.
	 */
	#handleSessionExpired(): void {
		this.reauthRequired = true;
		this.signInError = 'Your session expired.';
		this.writeError = 'Save failed — signed out.';
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
		// Persist this edit immediately with pendingWrite=true so it survives a reload.
		saveMySnapshot(this.roomId, this.mySelections, true);
		this.#schedulePut();
	}

	// ---- Notifications ----

	/**
	 * Lazily fetch notification settings the first time they're needed (opening the
	 * Picks tab), so a room member who never looks at Picks never pays for the request.
	 * Guests can't have push on, so this is a no-op for them.
	 */
	ensureNotificationSettingsLoaded(): void {
		if (this.isGuestMode || this.#notificationSettingsRequested) return;
		this.#notificationSettingsRequested = true;
		void this.#loadNotificationSettings();
	}

	async #loadNotificationSettings(): Promise<void> {
		const res = await getNotificationSettings();
		if (res.ok) {
			this.notificationSettings = res.data;
			return;
		}
		if (res.unauthorized) this.#handleSessionExpired();
		// A transient failure shouldn't permanently block the bells: let the next Picks
		// open try again, instead of leaving `notificationSettings` null forever.
		this.#notificationSettingsRequested = false;
	}

	/**
	 * Adopt settings the Notifications dialog just loaded or saved, so the Picks tab's
	 * bells never disagree with what the dialog shows — without this, a change made in
	 * the dialog would only reach the bells on the next full settings fetch.
	 *
	 * Merged onto whatever's cached rather than replacing it outright: the dialog's save
	 * response only echoes `leadMinutes`/`notifyMaybe` (see `saveNotificationSettings` in
	 * api.ts), not the full settings shape, and replacing wholesale would wipe
	 * `notifyOverrides`/`enabled` the bells still need.
	 */
	setNotificationSettings(settings: Partial<NotificationSettings>): void {
		this.notificationSettings = {
			...(this.notificationSettings ?? {
				leadMinutes: 15,
				notifyMaybe: false,
				notifyOverrides: {},
				enabled: false,
				subscribedHere: false
			}),
			...settings
		};
	}

	/**
	 * Flip one performance's notification bell. Writes an explicit override, unless that
	 * would just restate the default rule — then the override key is dropped instead, so
	 * later changes to the "maybe" setting keep flowing through to untouched performances.
	 */
	toggleNotifyOverride(performanceId: string): void {
		if (!this.notificationsAvailable) return;
		const state = this.myState(performanceId);
		if (state === 0) return;

		const previousSettings = this.notificationSettings;
		if (!previousSettings) return;

		const defaultNotify = effectiveNotify(state, this.notifyMaybeSetting);
		const currentNotify = effectiveNotify(state, this.notifyMaybeSetting, this.notifyOverrides[performanceId]);
		const nextOverride = !currentNotify === defaultNotify ? null : !currentNotify;
		const nextOverrides = { ...previousSettings.notifyOverrides };
		if (nextOverride === null) delete nextOverrides[performanceId];
		else nextOverrides[performanceId] = nextOverride;
		this.notificationSettings = { ...previousSettings, notifyOverrides: nextOverrides };
		haptic();

		const seq = ++this.#notifyWriteSeq;
		void this.#persistNotifyOverride(performanceId, nextOverride, seq, previousSettings);
	}

	async #persistNotifyOverride(
		performanceId: string,
		value: boolean | null,
		seq: number,
		previousSettings: NotificationSettings
	): Promise<void> {
		const res = await saveNotificationOverride(performanceId, value);
		if (seq !== this.#notifyWriteSeq) return; // Superseded by a later toggle.
		if (res.ok) {
			this.writeError = '';
			return;
		}
		if (res.unauthorized) {
			this.#handleSessionExpired();
		} else {
			const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
			this.writeError = isOffline
				? "Weak connection — try again once you're back online."
				: "Couldn't update notifications — please try again.";
		}
		// Revert the optimistic flip either way: an expired session or a failed write both
		// mean the server never saw it. Unlike picks (debounced, retried by the poll loop),
		// a bell tap is a one-shot write with nothing to retry it automatically.
		this.notificationSettings = previousSettings;
	}

	isFavouriteStage(stageName: string): boolean {
		return this.favouriteStages.has(stageName);
	}

	/** Float a stage to the front, or drop it back. A local view preference — no sign-in gate. */
	toggleFavouriteStage(stageName: string): void {
		const next = new Set(this.favouriteStages);
		if (next.has(stageName)) next.delete(stageName);
		else next.add(stageName);
		this.favouriteStages = next;
		saveFavouriteStages(this.roomId, next);
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
		if (mode === 'picks') this.ensureNotificationSettingsLoaded();
	}

	/** Index of the day containing the given performance, or -1 if it isn't in the timetable. */
	dayIndexForPerformance(performanceId: string): number {
		const days = this.timetable.days ?? [];
		for (let i = 0; i < days.length; i++) {
			if ((days[i]?.performances ?? []).some((p) => p.id === performanceId)) return i;
		}
		return -1;
	}

	/**
	 * Deep-link to a performance (from a `#perf-{id}` hash / push tap): switch to its day on the
	 * timetable view and mark it for the grid's highlight. Returns false if the id is unknown, so
	 * the caller can skip scrolling. Scrolling itself is the page's job — it needs the DOM.
	 */
	focusPerformance(performanceId: string): boolean {
		const dayIdx = this.dayIndexForPerformance(performanceId);
		if (dayIdx < 0) return false;
		// The set only renders on the Timetable panel (in either layout), so a deep-link
		// out of the Picks tab must return there first.
		this.viewMode = 'full';
		this.currentDayIdx = dayIdx;
		this.highlightedPerfId = performanceId;
		return true;
	}

	/** Flip the Timetable panel between the grid and the list, and remember the choice. */
	toggleTimetableLayout(): void {
		this.timetableLayout = this.timetableLayout === 'grid' ? 'list' : 'grid';
		saveTimetableLayout(this.timetableLayout);
		haptic();
	}

	// ---- Artist details ----

	openDetails(performance: Performance): void {
		if (this.joinModalOpen) return;
		this.detailsPerformance = performance;
		// So the bell reflects reality even when the card is opened before the Picks tab
		// ever was — otherwise a subscribed viewer would see it read "off" until then.
		this.ensureNotificationSettingsLoaded();
		// A history entry means the phone back gesture closes the card instead of the room.
		if (typeof history !== 'undefined') {
			history.pushState({ stagehopperDetails: true }, '');
		}
	}

	/** Open the details card from the Picks list, resolving the performance by id. */
	openDetailsById(performanceId: string): void {
		for (const day of this.timetable.days ?? []) {
			for (const performance of day.performances ?? []) {
				if (performance.id === performanceId) {
					this.openDetails(performance);
					return;
				}
			}
		}
	}

	closeDetails(): void {
		if (typeof history !== 'undefined' && history.state?.stagehopperDetails) {
			history.back();
			return;
		}
		this.detailsPerformance = null;
	}

	openMap(): void {
		this.mapOpen = true;
		if (typeof history !== 'undefined') {
			history.pushState({ stagehopperMap: true }, '');
		}
	}

	closeMap(): void {
		if (typeof history !== 'undefined' && history.state?.stagehopperMap) {
			history.back();
			return;
		}
		this.mapOpen = false;
	}

	/**
	 * The browser went back past an overlay's history entry.
	 *
	 * The details card can be opened on top of the map, so one back-gesture must pop
	 * just the details card when it's open, leaving the map in place — clearing
	 * everything unconditionally would drop the map too on what the user experienced
	 * as a single "close details" action.
	 */
	handlePopState(): void {
		if (this.detailsPerformance) {
			this.detailsPerformance = null;
			return;
		}
		this.mapOpen = false;
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
		// Picks restored from an unsynced snapshot survive the join. They are only non-empty
		// when this browser already marked something in this room, and clearing them here used
		// to erase exactly that — then PUT the empty map over the server copy.
		saveRoomIdentity(this.roomId, trimmedName, this.joinColor);
		this.joinModalOpen = false;

		const action = this.pendingGuestAction;
		this.pendingGuestAction = null;
		this.creatingGuestRoom = false;

		// Name/color just chosen after a fresh login/join — the deferred moment to pitch install.
		// Before the action branches below, which return early on a queued performance tap.
		maybeOpenInstallPromo();

		if (action?.type === 'perf') {
			this.togglePerformance(action.performanceId);
			return;
		}
		void this.#writeSelections();
	}

	// ---- Guest sign-in ----

	/** A signed-out browser tried to mark something: sign in, then replay the action. */
	requestGuestAction(type: PendingGuestAction['type'], performanceId: string): void {
		if (this.creatingGuestRoom) return;
		this.pendingGuestAction = { type, performanceId };
		if (auth.user) {
			void this.createGuestRoomAndNavigate();
			return;
		}
		this.guestSigninOpen = true;
		this.signInError = '';
	}

	/** Sign-in offered from the menu rather than triggered by a gated tap. */
	openGuestSignin(): void {
		this.pendingGuestAction = null;
		this.guestSigninOpen = true;
		this.signInError = '';
	}

	cancelGuestSignin(): void {
		this.guestSigninOpen = false;
		this.pendingGuestAction = null;
	}

	/**
	 * Clerk finished a sign-in. Nothing is passed in and nothing is stored: Clerk owns the
	 * session, so this only picks up the identity it has already established.
	 */
	handleSignedIn(): void {
		const user = auth.user;
		if (!user) {
			this.signInError = 'Sign-in failed. Please try again.';
			return;
		}

		this.userId = `clerk:${user.id}`;
		this.hasGlobalAuth = true;
		this.signInError = '';
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
		const result = await createRoom(newRoomId, festival.id);
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

	/**
	 * Clerk finished a sign-in after {@link #handleSessionExpired}. The account has to be
	 * the same one: the room's picks are keyed to it, and a different account would silently
	 * write this user's selections under someone else's key.
	 */
	handleReauthenticated(): void {
		const user = auth.user;
		if (!user || `clerk:${user.id}` !== this.userId) {
			this.signInError = 'Please sign in with the same account.';
			return;
		}

		this.reauthRequired = false;
		this.signInError = '';
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

		const result = await leaveRoomRequest(this.roomId);
		if (!result.ok) {
			this.leaveError = 'Could not leave the room. Please try again.';
			this.leavingRoom = false;
			return;
		}

		clearRoomSnapshots(this.roomId);
		this.leavingRoom = false;
		this.leaveDialogOpen = false;
		this.#deps.navigate('/');
	}

	async signOut(): Promise<void> {
		clearAllRoomSnapshots();
		await endSession();
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
					title: this.roomDisplayName ?? festival?.name ?? 'StageHopper',
					text: this.isGuestMode
						? 'Check out this StageHopper festival lineup'
						: this.roomDisplayName
							? `Join ${this.roomDisplayName} on StageHopper`
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
