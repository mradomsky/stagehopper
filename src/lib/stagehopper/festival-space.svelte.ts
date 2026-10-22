/**
 * @file The state of the Festival page: the Timetable, everyone's Picks, my own Picks, my
 * Colour, and the rules that keep them in step with the backend.
 *
 * The page renders this and owns no logic. Interface:
 *
 * - `open(festivalId)` (idempotent per id), `dispose()`.
 * - `togglePick(performanceId)`: the one entry for a tap. It hides the Visitor, no-Colour,
 *   offline and expired-session cases: going, then maybe, then off.
 * - `chooseColour(colour)`, `cancelColour()`, `onSignedIn()`, `cancelSignIn()`.
 * - Reads: Days and view state, `picksOf`, `goingCount`, `attendees`, `myState`, `myPicks`,
 *   `profile`, `status`, `colourRequired`, `signInRequired`, `notice`, notification settings.
 *
 * Invariants worth knowing before editing the write path:
 *
 * 1. `PUT picks` replaces the whole map and an empty map deletes the row. So nothing is
 *    written until `picks/me` has loaded, and a write is always `{...serverMine, ...edits}`.
 * 2. Unsaved edits are kept apart from the server's copy (`#dirty` over `#serverMine`), so a
 *    re-read of `picks/me` on every poll and on return to the tab can never drop an edit, and
 *    a map another device saved is picked up before we write.
 * 3. A read that began before a write started, or while one is in flight, is discarded.
 */

import {
	fetchFestivalPicks,
	fetchMyFestivalPicks,
	fetchProfile,
	getNotificationSettings,
	putFestivalPicks,
	putProfileColour,
	saveNotificationOverride,
	type AttendeeProfile,
	type FestivalPickRow,
	type NotificationSettings
} from './api.js';
import { auth, loadAuth, signOut as endSession } from './auth.svelte.js';
import { STORAGE_PREFIX } from './config.js';
import { ensureFestivalsLoaded, getFestivalById } from './festivals.svelte.js';
import { haptic } from './haptics.js';
import { maybeOpenInstallPromo } from './install.js';
import { effectiveNotify } from './picks.js';
import { entryScrollTargetId, groupScheduleByDay, picksOf as narrowToPicks } from './schedule-list.js';
import { DEFAULT_COLOR, PARTICIPANT_COLORS, cycleState, stateOf } from './selections.js';
import {
	loadFavouriteStages,
	loadTimetableLayout,
	readItem,
	removeItem,
	saveFavouriteStages,
	saveTimetableLayout,
	writeItem
} from './storage.js';
import { buildDayGrid } from './day-grid.js';
import {
	clockMinutes,
	getCurrentDayIdx,
	getInitialDayIdx,
	projectClockMinToGrid,
	PX_PER_MIN
} from './time.js';
import { fetchTimetableForFestival, orderStagesByFavourite, resolveStageOrder } from './timetable.js';
import type {
	AttendeePick,
	Performance,
	SelectionMap,
	SelectionState,
	Timetable,
	TimetableLayout,
	ViewMode
} from './types.js';

/** How often everyone's Picks (and my own, for another device's edits) are re-read. */
export const POLL_INTERVAL_MS = 30_000;
/** How long after the last tap a write waits, so a burst of taps is one request. */
export const PUT_DEBOUNCE_MS = 500;
/** Failed saves in a row before the page stops retrying and shows an error. */
const MAX_SAVE_FAILURES = 3;
/** Pickers listed in the Attendees popover; the rest are counted. */
const ATTENDEES_SHOWN = 50;
const NOW_TICK_MS = 60_000;
const COPIED_FEEDBACK_MS = 2000;

/** What the backend says, matched loosely: the only way to tell its 400s apart. */
const COLOUR_REQUIRED = /colour/i;
const HANDLE_REQUIRED = /handle/i;
/** Shown when a user has no username: they cannot save Picks or a Colour until they set one (#187). */
export const USERNAME_NOTICE = 'Set a username in your account to save Picks.';
/** Where a Visitor's tapped Performance travels across sign-in: it survives Clerk's redirect. */
const PENDING_TAP_PARAM = 'tap';

const EMPTY_TIMETABLE: Timetable = { festival: '', days: [] };

/** My sync state in one word, for the status bar. */
export type SyncStatus = 'synced' | 'pending' | 'offline' | 'error';

/**
 * Whether this document was loaded by moving through history rather than by a link or a
 * redirect. Clerk's sign-in steps each leave an entry that still carries the tap; replaying
 * one of those on going back would save a Pick nobody just tapped.
 */
function arrivedByHistory(): boolean {
	if (typeof performance === 'undefined') return false;
	const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
	return entry?.type === 'back_forward';
}

/** The first 50 marks and how many more there are: what the Attendees popover lists. */
export function capAttendees(marks: AttendeePick[]): { shown: AttendeePick[]; more: number } {
	return { shown: marks.slice(0, ATTENDEES_SHOWN), more: Math.max(0, marks.length - ATTENDEES_SHOWN) };
}

/** A map without the 0 (unmarked) entries, which is what the backend stores. */
function compact(map: SelectionMap): SelectionMap {
	return Object.fromEntries(Object.entries(map).filter(([, state]) => state !== 0)) as SelectionMap;
}

export interface FestivalSpaceDeps {
	isOnline: () => boolean;
	isHidden: () => boolean;
}

const defaultDeps: FestivalSpaceDeps = {
	isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
	isHidden: () => typeof document !== 'undefined' && document.hidden
};

export class FestivalSpace {
	#deps: FestivalSpaceDeps;

	festivalId = $state('');

	// ---- Timetable ----
	timetable = $state<Timetable>(EMPTY_TIMETABLE);
	timetableLoading = $state(true);
	timetableError = $state('');
	/** The id is in no Festival list: nothing is loaded, polled or saved for it. */
	notFound = $state(false);

	// ---- Picks ----
	/** Everyone's Picks as last read, grouped by Performance. No user ids: see {@link picksOf}. */
	publicPicks = $state<Record<string, FestivalPickRow[]>>({});
	/** My map as the server last had it. Valid only once {@link mineLoaded}. */
	#serverMine = $state<SelectionMap>({});
	/** My edits the server has not acknowledged, over {@link #serverMine}. */
	#dirty = $state<SelectionMap>({});
	/** The edits held back while the Colour modal is open; dropped if it is cancelled. */
	#held: SelectionMap = {};
	mineLoaded = $state(false);
	/** Handle (read-only, from Clerk) and Colour; null until the profile read has answered. */
	profile = $state<AttendeeProfile | null>(null);

	// ---- Status ----
	colourRequired = $state(false);
	/** Why the last Colour save failed, for the Colour modal only. */
	colourError = $state('');
	signInRequired = $state(false);
	/** A sentence for the user about the last thing that went wrong, or ''. */
	notice = $state('');
	#writeError = $state('');
	#gaveUp = $state(false);

	// ---- View ----
	currentDayIdx = $state(0);
	viewMode = $state<ViewMode>('full');
	timetableLayout = $state<TimetableLayout>(loadTimetableLayout());
	highlightedPerfId = $state<string | null>(null);
	favouriteStages = $state<ReadonlySet<string>>(new Set());
	now = $state<Date | null>(null);
	nowInstant = $derived(this.now ?? new Date());
	detailsPerformance = $state<Performance | null>(null);
	mapOpen = $state(false);
	copied = $state(false);
	notificationSettings = $state<NotificationSettings | null>(null);

	// ---- Internals ----
	#token = 0;
	#disposed = false;
	#opening: Promise<void> = Promise.resolve();
	#timetableDone: Promise<void> = Promise.resolve();
	#sessionUser = '';
	#readyHandled = false;
	#putTimer: ReturnType<typeof setTimeout> | null = null;
	#pollTimer: ReturnType<typeof setInterval> | null = null;
	#nowTimer: ReturnType<typeof setInterval> | null = null;
	#copiedTimer: ReturnType<typeof setTimeout> | null = null;
	#writing = false;
	#writeAgain = false;
	/** Bumped when a write starts and when it ends; a read that straddles either is stale. */
	#epoch = 0;
	#failures = 0;
	#sessionExpired = false;
	#promoTried = false;
	#notificationSettingsRequested = false;
	#notifyWriteSeq = 0;

	#onVisibilityChange = () => {
		if (this.#deps.isHidden()) this.flush();
		else this.#poll();
	};
	#onPageHide = () => this.flush();

	constructor(deps: Partial<FestivalSpaceDeps> = {}) {
		this.#deps = { ...defaultDeps, ...deps };
	}

	// ---- Derived view model ----

	get festival() {
		return getFestivalById(this.festivalId);
	}
	get mapUrl(): string | null {
		return this.festival?.mapUrl ?? null;
	}
	get stageColors(): Record<string, string> | undefined {
		return this.festival?.stageColors;
	}
	get signedIn(): boolean {
		return auth.user != null;
	}
	readonly colours = PARTICIPANT_COLORS;

	stageOrder = $derived(
		orderStagesByFavourite(
			resolveStageOrder(this.timetable, this.festival?.stageOrder),
			this.favouriteStages
		)
	);
	currentDay = $derived(this.timetable.days[this.currentDayIdx]);
	grid = $derived(buildDayGrid(this.currentDay, this.stageOrder));
	nowMin = $derived(
		this.now === null ? -1 : projectClockMinToGrid(clockMinutes(this.now), this.grid.startMin)
	);
	nowTopPx = $derived((this.nowMin - this.grid.startMin) * PX_PER_MIN);
	todayDayIdx = $derived(getCurrentDayIdx(this.timetable.days, this.nowInstant));
	nowVisible = $derived(
		this.currentDayIdx === this.todayDayIdx &&
			this.nowMin >= this.grid.startMin &&
			this.nowMin < this.grid.endMin
	);
	todayDate = $derived(this.timetable.days[this.todayDayIdx]?.date ?? null);
	scheduleGroups = $derived(groupScheduleByDay(this.timetable, this.stageOrder, this.nowInstant));
	scheduleScrollTargetId = $derived(
		entryScrollTargetId(this.scheduleGroups, this.currentDayIdx, this.todayDate)
	);

	/** My map as shown: the server's copy under my unsaved edits. */
	mySelections: SelectionMap = $derived({ ...this.#serverMine, ...this.#dirty });
	hasPendingWrite = $derived(Object.keys(this.#dirty).length > 0);
	/** My Picks (going and maybe) only, by Day in time order. */
	myPicks = $derived(narrowToPicks(this.scheduleGroups, this.mySelections));
	pickScrollTargetId = $derived.by(() => {
		for (const group of this.myPicks) {
			for (const row of group.rows) {
				if (row.timing !== 'past') return row.performance.id;
			}
		}
		return null;
	});

	status: SyncStatus = $derived.by(() => {
		if (!this.#deps.isOnline()) return 'offline';
		if (this.#writeError) return 'error';
		if (this.hasPendingWrite) return 'pending';
		return 'synced';
	});
	/** The message for the status bar. */
	syncError = $derived(this.#writeError);

	get #ready(): boolean {
		return this.mineLoaded && this.profile !== null;
	}

	myState(performanceId: string): SelectionState {
		return stateOf(this.mySelections, performanceId);
	}

	/**
	 * Everyone who picked a Performance, going before maybe, me included.
	 *
	 * The public read carries no user id, so my own row is recognised by my Handle (a
	 * non-empty Handle is the unique Clerk username) and replaced by my local state, drawn in
	 * my Colour: the public copy is eventually consistent and a freshly chosen Colour has to
	 * show at once. Marks get synthetic unique keys for the shared components.
	 * shortcut: a user whose username changed since their last save shows twice until their
	 * next save rewrites the row; upgrade by returning the stored Handle from picks/me.
	 */
	picksOf(performanceId: string): AttendeePick[] {
		const ownHandle = this.signedIn && this.mineLoaded ? (this.profile?.handle ?? '') : '';
		const marks: AttendeePick[] = (this.publicPicks[performanceId] ?? [])
			.filter((row) => !(ownHandle && row.handle === ownHandle))
			.map((row, i) => ({
				userId: `${i}:${row.handle}`,
				name: row.handle,
				color: row.colour || DEFAULT_COLOR,
				state: row.state as SelectionState
			}));
		const mine = this.signedIn ? this.myState(performanceId) : 0;
		if (mine > 0) {
			marks.push({
				userId: 'self',
				name: this.profile?.handle ?? '',
				color: this.profile?.colour ?? DEFAULT_COLOR,
				state: mine
			});
		}
		return marks.sort((a, b) => a.state - b.state);
	}

	/** What the pill draws: those going. Maybe appears only in the popover. */
	goingMarks(performanceId: string): AttendeePick[] {
		return this.picksOf(performanceId).filter((mark) => mark.state === 1);
	}

	/** The pill: how many are going. */
	goingCount(performanceId: string): number {
		return this.goingMarks(performanceId).length;
	}

	/** The popover: the first 50 pickers, going first, and how many more there are. */
	attendees(performanceId: string): { shown: AttendeePick[]; more: number } {
		return capAttendees(this.picksOf(performanceId));
	}

	/** Whether a Pick triggers a Reminder: the bell's state. */
	notifyStateOf(performanceId: string): boolean {
		return effectiveNotify(
			this.myState(performanceId),
			this.notificationSettings?.notifyMaybe ?? false,
			this.notificationSettings?.notifyOverrides[performanceId]
		);
	}
	notificationsAvailable = $derived(this.notificationSettings?.enabled ?? false);

	// ---- Lifecycle ----

	/** Point at a Festival: load the Timetable and everyone's Picks, then my session if any. */
	open(festivalId: string): Promise<void> {
		if (this.festivalId === festivalId && !this.#disposed) return this.#opening;
		const token = ++this.#token;
		this.#disposed = false;
		this.#cancelPut();
		this.#stopTimers();
		this.festivalId = festivalId;
		this.notFound = false;
		this.publicPicks = {};
		this.#resetSession();
		this.detailsPerformance = null;
		this.mapOpen = false;
		this.highlightedPerfId = null;
		this.signInRequired = false;
		this.notice = '';
		this.favouriteStages = loadFavouriteStages(festivalId);

		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', this.#onVisibilityChange);
		}
		if (typeof window !== 'undefined') window.addEventListener('pagehide', this.#onPageHide);
		this.tickNow();
		this.#nowTimer = setInterval(() => this.tickNow(), NOW_TICK_MS);
		this.#pollTimer = setInterval(() => this.#poll(), POLL_INTERVAL_MS);

		this.#opening = this.#load(token);
		return this.#opening;
	}

	async #load(token: number): Promise<void> {
		// A cold reload races the layout's Festival list fetch, so an id missing from the
		// compiled defaults is only unknown once the live list has been read.
		if (!getFestivalById(this.festivalId)) await ensureFestivalsLoaded();
		if (token !== this.#token) return;
		if (!getFestivalById(this.festivalId)) {
			this.notFound = true;
			this.timetableLoading = false;
			return;
		}
		this.#timetableDone = this.#loadTimetable(token);
		const picks = this.#refreshPublic(token);
		await loadAuth();
		await Promise.all([this.#timetableDone, picks, this.#startSession(token)]);
	}

	dispose(): void {
		this.#disposed = true;
		this.#token++;
		this.#cancelPut();
		this.#stopTimers();
		if (this.#copiedTimer) clearTimeout(this.#copiedTimer);
		this.#copiedTimer = null;
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', this.#onVisibilityChange);
		}
		if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.#onPageHide);
	}

	#stopTimers(): void {
		if (this.#pollTimer) clearInterval(this.#pollTimer);
		if (this.#nowTimer) clearInterval(this.#nowTimer);
		this.#pollTimer = null;
		this.#nowTimer = null;
	}

	tickNow(): void {
		this.now = new Date();
	}

	// ---- Reads ----

	async #loadTimetable(token: number): Promise<void> {
		this.timetableLoading = true;
		this.timetableError = '';
		const result = await fetchTimetableForFestival(this.festivalId, this.festival?.name ?? '');
		if (token !== this.#token) return;
		this.timetableLoading = false;
		if (!result.ok) {
			this.timetableError = 'Could not load the timetable. Please try again.';
			return;
		}
		this.timetable = result.data;
		this.currentDayIdx = getInitialDayIdx(this.timetable.days);
	}

	async retryTimetable(): Promise<void> {
		this.#timetableDone = this.#loadTimetable(this.#token);
		await this.#timetableDone;
		this.#checkReady();
	}

	/** Keeps the last snapshot when the read fails. */
	async #refreshPublic(token = this.#token): Promise<void> {
		const result = await fetchFestivalPicks(this.festivalId);
		if (token !== this.#token || !result.ok) return;
		if (result.data && typeof result.data === 'object') this.publicPicks = result.data;
	}

	async #loadProfile(token = this.#token): Promise<void> {
		const result = await fetchProfile();
		if (token !== this.#token || !result.ok) return;
		this.profile = { handle: result.data.handle ?? '', colour: result.data.colour ?? null };
		this.#checkReady();
	}

	async #loadMine(token = this.#token): Promise<void> {
		const epoch = this.#epoch;
		const result = await fetchMyFestivalPicks(this.festivalId);
		if (token !== this.#token || !result.ok) return;
		// A write began or ended while this was in flight: the answer predates it.
		if (epoch !== this.#epoch || this.#writing) return;
		this.#serverMine = compact(result.data.selections ?? {});
		this.mineLoaded = true;
		this.#checkReady();
	}

	/** One poll tick, also run at once on return to the tab. */
	#poll(): void {
		if (this.#deps.isHidden() || this.#disposed || this.notFound) return;
		void this.#refreshPublic();
		if (!this.signedIn || !this.#sessionUser) return;
		if (!this.profile) void this.#loadProfile();
		if (!this.#writing) void this.#loadMine();
		if (this.hasPendingWrite && !this.#putTimer && !this.#gaveUp) void this.#write();
	}

	// ---- Session ----

	#resetSession(): void {
		this.#serverMine = {};
		this.#dirty = {};
		this.#held = {};
		this.mineLoaded = false;
		this.profile = null;
		this.colourRequired = false;
		this.#writeError = '';
		this.#gaveUp = false;
		this.#failures = 0;
		this.#sessionExpired = false;
		this.#sessionUser = '';
		this.#readyHandled = false;
		this.notificationSettings = null;
		this.#notificationSettingsRequested = false;
	}

	/** Load my profile and Picks if someone is signed in. Once per user. */
	async #startSession(token: number): Promise<void> {
		const user = auth.user;
		if (!user || this.#sessionUser === user.id) return;
		this.#sessionUser = user.id;
		this.#restoreDirty();
		this.ensureNotificationSettingsLoaded();
		await Promise.all([this.#loadProfile(token), this.#loadMine(token)]);
		await this.#timetableDone;
		if (token === this.#token) this.#checkReady();
	}

	/**
	 * Clerk finished a sign-in without reloading the page. After a reload `open` does the same
	 * on its own, so this only has to handle the in-page case.
	 */
	async onSignedIn(): Promise<void> {
		if (!auth.user) return;
		this.signInRequired = false;
		this.#sessionExpired = false;
		this.#writeError = '';
		this.notice = '';
		// A different account: the unsaved Picks belong to the first one (kept in storage under
		// its id), so they must not be saved under this one.
		if (this.#sessionUser && this.#sessionUser !== auth.user.id) {
			this.#cancelPut();
			this.#resetSession();
		}
		if (this.#sessionUser === auth.user.id) {
			void this.#write();
			return;
		}
		await this.#startSession(this.#token);
	}

	openSignIn(): void {
		this.#setPendingTap(null);
		this.signInRequired = true;
	}

	cancelSignIn(): void {
		this.signInRequired = false;
		this.#setPendingTap(null);
	}

	async signOut(): Promise<void> {
		if (this.#sessionUser) removeItem(this.#pendingKey(this.#sessionUser));
		this.#cancelPut();
		this.#resetSession();
		await endSession();
	}

	/** My profile and Picks have both loaded: settle what was waiting for them. */
	#checkReady(): void {
		// Waits for the Timetable too: the Pending Pick is only valid against it, and this runs once.
		if (!this.#ready || this.timetableLoading || this.#readyHandled || this.#disposed) return;
		this.#readyHandled = true;
		// Edits made (or restored from a reload) before the profile answered, and no Colour:
		// they wait for the Colour modal like any first Pick.
		if (!this.profile?.colour && this.hasPendingWrite) this.#holdForColour(this.#dirty);
		this.#applyPendingTap();
		if (this.hasPendingWrite && !this.colourRequired) this.#scheduleWrite();
	}

	// ---- Picks ----

	/** A tap on a Performance: going, then maybe, then off. */
	togglePick(performanceId: string): void {
		if (this.#disposed || this.notFound || this.colourRequired) return;
		if (!auth.user) {
			// In the URL, not in this object: Clerk's sign-in ends in a full page load.
			this.#setPendingTap(performanceId);
			this.signInRequired = true;
			return;
		}
		haptic();
		this.#edit(performanceId, cycleState(this.myState(performanceId)));
	}

	#edit(performanceId: string, state: SelectionState): void {
		if (this.profile && !this.profile.colour) {
			this.#holdForColour({ [performanceId]: state });
			return;
		}
		this.#dirty = { ...this.#dirty, [performanceId]: state };
		this.#failures = 0;
		this.#gaveUp = false;
		this.#writeError = '';
		this.notice = '';
		this.#persistDirty();
		if (this.#ready) this.#scheduleWrite();
	}

	#holdForColour(edits: SelectionMap): void {
		this.#held = { ...this.#held, ...edits };
		this.#dirty = {};
		this.#persistDirty();
		this.colourRequired = true;
	}

	/** Save my Colour; then any Pick held for it is saved too. */
	async chooseColour(colour: string): Promise<void> {
		this.colourError = '';
		const result = await putProfileColour(colour);
		if (!result.ok && result.status === 400 && HANDLE_REQUIRED.test(result.error ?? '')) {
			// No username: the Colour cannot be saved, so neither can the Pick it was holding.
			this.#held = {};
			this.colourRequired = false;
			this.notice = USERNAME_NOTICE;
			return;
		}
		if (!result.ok) {
			this.colourError = result.unauthorized
				? 'You were signed out. Sign in to save your colour.'
				: "Couldn't save your colour. Please try again.";
			return;
		}
		this.profile = { handle: result.data.handle ?? this.profile?.handle ?? '', colour };
		this.notice = '';
		this.colourRequired = false;
		if (Object.keys(this.#held).length > 0) {
			this.#dirty = { ...this.#dirty, ...this.#held };
			this.#held = {};
			this.#persistDirty();
		}
		if (this.hasPendingWrite) this.flush();
	}

	/** The Colour modal was dismissed: whatever it was holding is dropped, nothing is saved. */
	cancelColour(): void {
		this.colourError = '';
		this.#held = {};
		this.#dirty = {};
		this.#persistDirty();
		this.colourRequired = false;
	}

	/** The Colour modal opened or closed from the menu: forget an old failure. */
	clearColourError(): void {
		this.colourError = '';
	}

	/** Write now, bypassing the debounce: the page is being hidden or a Colour just landed. */
	flush(): void {
		if (!this.hasPendingWrite || this.#disposed) return;
		this.#cancelPut();
		void this.#write();
	}

	#scheduleWrite(): void {
		this.#cancelPut();
		this.#putTimer = setTimeout(() => {
			this.#putTimer = null;
			void this.#write();
		}, PUT_DEBOUNCE_MS);
	}

	#cancelPut(): void {
		if (this.#putTimer) clearTimeout(this.#putTimer);
		this.#putTimer = null;
	}

	async #write(): Promise<void> {
		if (!this.#ready || !auth.user || this.colourRequired || this.#sessionExpired) return;
		if (this.#writing) {
			this.#writeAgain = true;
			return;
		}
		const token = this.#token;
		this.#writing = true;
		try {
			do {
				this.#writeAgain = false;
				const sent = { ...this.#dirty };
				if (Object.keys(sent).length === 0) return;
				const map = compact({ ...this.#serverMine, ...sent });
				this.#epoch++;
				const result = await putFestivalPicks(this.festivalId, map);
				this.#epoch++;
				if (token !== this.#token) return;

				if (!result.ok) {
					this.#handleWriteFailure(result, sent);
					return;
				}
				this.#serverMine = map;
				const rest = { ...this.#dirty };
				for (const [id, state] of Object.entries(sent)) {
					if (rest[id] === state) delete rest[id];
				}
				this.#dirty = rest;
				this.#persistDirty();
				this.#failures = 0;
				this.#writeError = '';
				// The moment to pitch install: a Pick has been saved.
				if (!this.#promoTried && Object.keys(map).length > 0) {
					this.#promoTried = true;
					maybeOpenInstallPromo();
				}
			} while (this.#writeAgain);
		} finally {
			this.#writing = false;
		}
	}

	#handleWriteFailure(
		result: { unauthorized: boolean; status: number; error?: string },
		sent: SelectionMap
	): void {
		if (result.unauthorized) {
			this.#sessionExpired = true;
			this.#writeError = 'Save failed — signed out.';
			this.notice = 'You were signed out. Sign in again to save your Picks.';
			return;
		}
		if (result.status === 400 && COLOUR_REQUIRED.test(result.error ?? '')) {
			// The server has no Colour for me; keep the edit and ask.
			this.colourRequired = true;
			return;
		}
		if (result.status >= 400 && result.status < 500 && result.status !== 429) {
			// The server will never take this edit: show the truth rather than a Pick that is not saved.
			// Only the edits that were sent: a tap made while the request was in flight is still good.
			const rest = { ...this.#dirty };
			for (const [id, state] of Object.entries(sent)) {
				if (rest[id] === state) delete rest[id];
			}
			this.#dirty = rest;
			this.#persistDirty();
			this.notice = HANDLE_REQUIRED.test(result.error ?? '')
				? USERNAME_NOTICE
				: "Couldn't save your Pick. Please try again.";
			return;
		}
		// Offline, a 5xx, or an /api 403/404 that CloudFront turned into 200 HTML (status 0,
		// #181): retry on the next poll, but not forever.
		if (this.#deps.isOnline() && ++this.#failures >= MAX_SAVE_FAILURES) {
			this.#gaveUp = true;
			this.#writeError = "Couldn't save your Picks. Check your connection and tap again.";
		}
	}

	// ---- Unsaved edits survive a reload ----

	#pendingKey(userId: string): string {
		return `${STORAGE_PREFIX}:${this.festivalId}:clerk:${userId}:pendingPicks`;
	}

	#persistDirty(): void {
		if (!this.#sessionUser) return;
		const key = this.#pendingKey(this.#sessionUser);
		if (this.hasPendingWrite) writeItem(key, JSON.stringify(this.#dirty));
		else removeItem(key);
	}

	#restoreDirty(): void {
		const raw = readItem(this.#pendingKey(this.#sessionUser));
		if (!raw) return;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === 'object') this.#dirty = parsed as SelectionMap;
		} catch {
			removeItem(this.#pendingKey(this.#sessionUser));
		}
	}

	// ---- Pending Pick (tap before sign-in) ----

	#pendingTap(): string | null {
		if (typeof window === 'undefined') return null;
		return new URL(window.location.href).searchParams.get(PENDING_TAP_PARAM);
	}

	/** Record or clear the tapped Performance on the current history entry, in place. */
	#setPendingTap(performanceId: string | null): void {
		if (typeof window === 'undefined') return;
		const url = new URL(window.location.href);
		if (performanceId === null) url.searchParams.delete(PENDING_TAP_PARAM);
		else url.searchParams.set(PENDING_TAP_PARAM, performanceId);
		if (url.href === window.location.href) return;
		history.replaceState(history.state, '', url);
	}

	/**
	 * Finish a tap that travelled through sign-in as going. The parameter is only text in a
	 * URL, so a Performance this Timetable lacks, or one already picked (a toggle would cycle
	 * it past), is ignored. Needs the Timetable, so it waits for it.
	 */
	#applyPendingTap(): void {
		const tap = this.#pendingTap();
		if (!tap || this.timetableLoading || this.timetableError) return;
		this.#setPendingTap(null);
		if (arrivedByHistory()) return;
		if (this.dayIndexForPerformance(tap) < 0 || this.myState(tap) !== 0) return;
		this.#edit(tap, 1);
	}

	// ---- Notifications ----

	ensureNotificationSettingsLoaded(): void {
		if (!this.signedIn || this.#notificationSettingsRequested) return;
		this.#notificationSettingsRequested = true;
		void (async () => {
			const result = await getNotificationSettings();
			if (result.ok) this.notificationSettings = result.data;
			else this.#notificationSettingsRequested = false;
		})();
	}

	/** Adopt settings the Notifications dialog loaded or saved, merged onto what is cached. */
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

	/** Flip one Performance's Reminder, dropping the override when it only restates the default. */
	toggleNotifyOverride(performanceId: string): void {
		const state = this.myState(performanceId);
		const previous = this.notificationSettings;
		if (!this.notificationsAvailable || state === 0 || !previous) return;

		const notifyMaybe = previous.notifyMaybe;
		const defaultNotify = effectiveNotify(state, notifyMaybe);
		const currentNotify = effectiveNotify(state, notifyMaybe, previous.notifyOverrides[performanceId]);
		const nextOverride = !currentNotify === defaultNotify ? null : !currentNotify;
		const overrides = { ...previous.notifyOverrides };
		if (nextOverride === null) delete overrides[performanceId];
		else overrides[performanceId] = nextOverride;
		this.notificationSettings = { ...previous, notifyOverrides: overrides };
		haptic();

		const seq = ++this.#notifyWriteSeq;
		void (async () => {
			const result = await saveNotificationOverride(performanceId, nextOverride);
			if (seq !== this.#notifyWriteSeq || result.ok) return;
			this.notificationSettings = previous;
			this.notice = result.unauthorized
				? 'You were signed out. Sign in again to change Reminders.'
				: "Couldn't update Reminders. Please try again.";
		})();
	}

	// ---- Days, view, layout ----

	selectDay(index: number): void {
		this.currentDayIdx = index;
	}

	stepDay(delta: number): void {
		const dayCount = this.timetable.days.length;
		if (dayCount === 0) return;
		this.currentDayIdx = (this.currentDayIdx + delta + dayCount) % dayCount;
		haptic();
	}

	setViewMode(mode: ViewMode): void {
		this.viewMode = mode;
	}

	dayIndexForPerformance(performanceId: string): number {
		const days = this.timetable.days ?? [];
		for (let i = 0; i < days.length; i++) {
			if ((days[i]?.performances ?? []).some((p) => p.id === performanceId)) return i;
		}
		return -1;
	}

	/** Deep-link (`#perf-{id}`, a Reminder tap): switch to its Day and highlight it. */
	focusPerformance(performanceId: string): boolean {
		const dayIdx = this.dayIndexForPerformance(performanceId);
		if (dayIdx < 0) return false;
		this.viewMode = 'full';
		this.currentDayIdx = dayIdx;
		this.highlightedPerfId = performanceId;
		return true;
	}

	toggleTimetableLayout(): void {
		this.timetableLayout = this.timetableLayout === 'grid' ? 'list' : 'grid';
		saveTimetableLayout(this.timetableLayout);
		haptic();
	}

	isFavouriteStage(stageName: string): boolean {
		return this.favouriteStages.has(stageName);
	}

	toggleFavouriteStage(stageName: string): void {
		const next = new Set(this.favouriteStages);
		if (next.has(stageName)) next.delete(stageName);
		else next.add(stageName);
		this.favouriteStages = next;
		saveFavouriteStages(this.festivalId, next);
		haptic();
	}

	// ---- Overlays ----

	openDetails(performance: Performance): void {
		this.detailsPerformance = performance;
		this.ensureNotificationSettingsLoaded();
		// A history entry makes the phone back gesture close the card instead of the page.
		if (typeof history !== 'undefined') history.pushState({ stagehopperDetails: true }, '');
	}

	openDetailsById(performanceId: string): void {
		for (const day of this.timetable.days ?? []) {
			const found = (day.performances ?? []).find((p) => p.id === performanceId);
			if (found) return this.openDetails(found);
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
		if (typeof history !== 'undefined') history.pushState({ stagehopperMap: true }, '');
	}

	closeMap(): void {
		if (typeof history !== 'undefined' && history.state?.stagehopperMap) {
			history.back();
			return;
		}
		this.mapOpen = false;
	}

	/** The browser went back past an overlay: a details card on top of the map closes first. */
	handlePopState(): void {
		if (this.detailsPerformance) {
			this.detailsPerformance = null;
			return;
		}
		this.mapOpen = false;
	}

	// ---- Share ----

	async share(): Promise<void> {
		if (typeof window === 'undefined') return;
		// Never with a pending tap: whoever opens the link would carry it into their own flow.
		const shared = new URL(window.location.href);
		shared.searchParams.delete(PENDING_TAP_PARAM);
		const url = shared.href;

		if (navigator.share) {
			try {
				await navigator.share({
					title: this.festival?.name ?? 'StageHopper',
					text: 'Check out this festival on StageHopper',
					url
				});
				return;
			} catch (error) {
				if ((error as { name?: string } | null)?.name === 'AbortError') return;
			}
		}

		try {
			await navigator.clipboard.writeText(url);
			this.copied = true;
			if (this.#copiedTimer) clearTimeout(this.#copiedTimer);
			this.#copiedTimer = setTimeout(() => (this.copied = false), COPIED_FEEDBACK_MS);
		} catch {
			// No clipboard access: nothing useful to report.
		}
	}
}
