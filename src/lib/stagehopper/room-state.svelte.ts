/**
 * @file All room-page state and behaviour, as a rune class.
 *
 * The page component renders this; it owns no logic of its own. Navigation is
 * injected so the class can be driven in tests without SvelteKit.
 */

import {
	createRoom,
	getNotificationSettings,
	leaveRoom as leaveRoomRequest,
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
import { generateRoomId, roomPath } from './rooms.js';
import { RoomSync, defaultRoomSyncDeps } from './room-sync.svelte.js';
import { entryScrollTargetId, groupScheduleByDay } from './schedule-list.js';
import {
	DEFAULT_COLOR,
	cycleState,
	firstAvailableColor,
	getParticipantMarks,
	stateOf,
	takenColorsExcluding,
	truncateName
} from './selections.js';
import {
	loadFavouriteStages,
	loadRoomIdentity,
	loadTimetableLayout,
	saveFavouriteStages,
	saveRoomIdentity,
	saveTimetableLayout
} from './storage.js';
import {
	clockMinutes,
	getCurrentDayIdx,
	getInitialDayIdx,
	projectClockMinToGrid,
	PX_PER_MIN
} from './time.js';
import { buildDayGrid } from './day-grid.js';
import { fetchTimetableForRoom, orderStagesByFavourite, resolveStageOrder } from './timetable.js';
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
	#nowTimer: ReturnType<typeof setInterval> | null = null;
	#copiedTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * Set once the page is torn down. Bootstrapping is async, so a room can be left
	 * while its first load is still in flight; without this, the load would resume and
	 * start a polling loop nothing will ever stop.
	 */
	#disposed = false;
	/**
	 * Whether the one automatic retry for the current expiry has already been spent.
	 *
	 * The re-auth prompt is raised by a 401 and taken down by {@link handleReauthenticated},
	 * which the page calls whenever someone is signed in and the prompt is up. That is a
	 * level, not an edge: when the 401 came from something other than a dead session — the
	 * gateway dropping the header, a mis-scoped token, clock skew — Clerk still reports a
	 * user, so the retry fires immediately, 401s again, raises the prompt again, and the
	 * page calls back in. One request per round trip, forever, with the prompt never on
	 * screen long enough to see.
	 *
	 * Signing in again cannot fix any of those, so the second attempt is refused and the
	 * prompt stays up. A genuinely expired session is unaffected: Clerk reports nobody
	 * signed in, the page's own guard holds until the user returns, and the retry that
	 * follows is the first one.
	 */
	#reauthRetryUsed = false;

	// ---- Identity ----
	/**
	 * The synced state of this room, and every rule for keeping it in step with the backend.
	 * The accessors just below forward to it, so callers keep reading `room.mySelections`.
	 */
	readonly sync: RoomSync;

	get roomId(): string {
		return this.sync.roomId;
	}
	get userId(): string {
		return this.sync.userId;
	}
	get myName(): string {
		return this.sync.myName;
	}
	get myColor(): string {
		return this.sync.myColor;
	}
	/** Everyone else's picks, as last read from the server or restored from the snapshot. */
	get otherSelections(): RoomSelection[] {
		return this.sync.otherSelections;
	}
	get mySelections(): SelectionMap {
		return this.sync.mySelections;
	}
	/** This room's custom display name, if the creator set one — see extractRoomDisplayName. */
	get roomDisplayName(): string | null {
		return this.sync.roomDisplayName;
	}

	/** Whether someone is signed in site-wide, used to offer sign-in while browsing. */
	hasGlobalAuth = $state(false);

	// ---- Room data ----
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
	 * clear an error the other half of the sync loop just raised. Both owned by
	 * {@link sync}; the setters exist for the non-sync failures raised here (creating a
	 * room, an expired session).
	 */
	get readError(): string {
		return this.sync.readError;
	}
	get writeError(): string {
		return this.sync.writeError;
	}
	set writeError(message: string) {
		this.sync.writeError = message;
	}
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
		this.sync = new RoomSync({
			...defaultRoomSyncDeps,
			festivalId: () => this.festivalId ?? undefined,
			onUnauthorized: () => this.#handleSessionExpired()
		});
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
	/** The day laid out: stages with sets, the vertical extent, the hour labels. */
	grid = $derived(buildDayGrid(this.currentDay, this.stageOrder));

	/** The message shown in the status bar; a failed save outranks a failed read. */
	syncError = $derived(this.writeError || this.readError);
	/**
	 * Everyone in the room, the viewer included, folded together from the fields that own each
	 * part. Derived rather than stored: it used to be kept in step by hand, so a toggle re-mapped
	 * the viewer's entry into it, joining rebuilt it, and three readers filtered the viewer back
	 * out of it — a fold and three unfolds of the same one fact.
	 */
	get allSelections(): RoomSelection[] {
		return this.sync.allSelections;
	}
	takenColors = $derived(takenColorsExcluding(this.allSelections, this.userId));

	/**
	 * The now-line, which is the room's own concern rather than the grid's: it moves with the
	 * clock rather than with the day, and the admin editor never draws one.
	 */
	nowMin = $derived(
		this.now === null ? -1 : projectClockMinToGrid(clockMinutes(this.now), this.grid.startMin)
	);
	nowTopPx = $derived((this.nowMin - this.grid.startMin) * PX_PER_MIN);
	/**
	 * Index of the festival day happening right now, or -1 when the festival isn't running
	 * today. Recomputed each clock tick so a rollover past the day boundary moves the line.
	 */
	todayDayIdx = $derived(getCurrentDayIdx(this.timetable.days, this.nowInstant));
	/** The now-line only belongs on the day currently in progress, and only while on-grid. */
	nowVisible = $derived(
		this.currentDayIdx === this.todayDayIdx &&
			this.nowMin >= this.grid.startMin &&
			this.nowMin < this.grid.endMin
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

	/**
	 * Marks by everyone except the viewer — the badges drawn on a performance block, where
	 * the viewer's own mark is already conveyed by the block's star.
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
		// The picks, the participants and the room's name go with sync.reset(), which the
		// caller runs: carrying them across a switch would make the previous room's
		// selections the local snapshot for this one.

		// Overlays and dialogs, all of which belong to the room being left.
		this.detailsPerformance = null;
		this.mapOpen = false;
		this.leaveDialogOpen = false;
		this.leavingRoom = false;
		this.leaveError = '';
		this.guestSigninOpen = false;
		this.signInError = '';
		this.reauthRequired = false;
		this.#reauthRetryUsed = false;
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
		// Points sync at the new room, drops the previous one's picks and errors, and
		// re-seeds from an unsynced snapshot. The viewer is not known yet — sign-in is
		// resolved below — so this pass only carries the room.
		this.sync.reset(roomId, '');
		this.favouriteStages = loadFavouriteStages(roomId);

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

		// Now that sign-in has resolved, re-point sync at the room *with* the viewer, which
		// is what lets it restore an unsynced snapshot keyed to them.
		this.sync.reset(roomId, `clerk:${user.id}`);
		// The timetable grid's per-set bells need this too now, not just the Picks tab —
		// no reason left to defer it until Picks is opened.
		this.ensureNotificationSettingsLoaded();

		const cached = loadRoomIdentity(roomId);
		this.sync.setIdentity(cached?.name ?? '', cached?.color ?? DEFAULT_COLOR);

		const [{ knownMember }] = await Promise.all([this.sync.load(), timetableLoad]);
		if (token !== this.#bootstrapToken || this.#disposed) return;

		if (knownMember) {
			// refresh() has already adopted the server's name for the viewer when there was one.
			this.sync.setIdentity(
				this.myName || cached?.name || user.givenName || user.name,
				this.myColor
			);
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
		// Keeps the room id (the browse target) but drops every trace of a viewer.
		this.sync.reset(this.roomId, '');
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

	/** Re-read the room from the backend and merge it with local edits. */
	refresh(options: { preferRemoteColor?: boolean } = {}): Promise<unknown> {
		return this.sync.refresh(options);
	}

	startPolling(): void {
		this.sync.startPolling();
	}

	stopPolling(): void {
		this.sync.stopPolling();
	}

	/** Tear down every timer. Call from the component's onDestroy. */
	dispose(): void {
		this.#disposed = true;
		this.sync.dispose();
		if (this.#nowTimer) clearInterval(this.#nowTimer);
		this.#nowTimer = null;
		if (this.#copiedTimer) clearTimeout(this.#copiedTimer);
		this.#copiedTimer = null;
	}

	/**
	 * Write out any debounced edit immediately — used when the page is being hidden or
	 * unloaded, where waiting out the debounce would silently drop the last pick.
	 *
	 * Sync flushes on `visibilitychange` and `pagehide` itself; this stays for callers
	 * that flush for their own reasons.
	 */
	flushPendingWrites(): void {
		this.sync.flush();
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

		haptic();
		this.sync.setSelection(performanceId, cycleState(this.myState(performanceId)));
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

		this.sync.setIdentity(trimmedName, this.joinColor);
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
		void this.sync.write();
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

		this.sync.reset(this.roomId, `clerk:${user.id}`);
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
		// Checked after the account, so a wrong-account attempt doesn't spend the retry the
		// right account still needs. See #reauthRetryUsed for why there is only one.
		if (this.#reauthRetryUsed) return;

		this.#reauthRetryUsed = true;
		this.reauthRequired = false;
		this.signInError = '';
		void this.#retryAfterReauth();
	}

	async #retryAfterReauth(): Promise<void> {
		await this.sync.write();
		// The prompt is back up only if that write was rejected too, which is the case the
		// retry is being withheld from. Anything else — saved, or failed for a reason a
		// sign-in has nothing to do with — leaves the next expiry its own attempt.
		if (!this.reauthRequired) this.#reauthRetryUsed = false;
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
		// Anything unsaved dies with the membership; flushing it later would re-create
		// the rows this call is about to delete.
		this.sync.discardPending();

		const result = await leaveRoomRequest(this.roomId);
		if (!result.ok) {
			this.leaveError = 'Could not leave the room. Please try again.';
			this.leavingRoom = false;
			return;
		}

		this.sync.forgetRoom();
		this.leavingRoom = false;
		this.leaveDialogOpen = false;
		this.#deps.navigate('/');
	}

	async signOut(): Promise<void> {
		RoomSync.forgetAllRooms();
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
