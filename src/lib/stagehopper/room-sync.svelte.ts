/**
 * @file Room sync: the one module that owns the synced state of a Room and every rule for
 * keeping it in step with the backend on a flaky connection.
 *
 * Interface (what {@link RoomState} and the tests use):
 *
 * - `reset(roomId, userId)` / `load(...)` — open a room, seed from the offline snapshot,
 *   read the server, fall back to the last-known picks if that fails, start polling.
 * - `setSelection(perfId, state)` — a local edit. Persisted at once, written after a debounce.
 * - `setIdentity(name, color)` / `write()` — a join or a re-auth that must write immediately.
 * - `refresh()`, `flush()`, `discardPending()`, `forgetRoom()`, `dispose()`.
 * - Reactive fields: viewer identity, `mySelections`, `otherSelections`, `roomDisplayName`,
 *   `readError`, `writeError`, `hasPendingWrite`, `status`.
 *
 * Everything else — debounce, write sequencing, the two-failure read debounce, polling that
 * pauses while hidden, the flush on backgrounding, snapshot keys, and the offline copy — is
 * implementation. It used to be spread over RoomState, storage.ts and the room page.
 *
 * Two adapters justify the seam: {@link defaultRoomSyncDeps} in the app, in-memory fakes in
 * `room-sync.spec.ts`.
 */

import { fetchRoomSelections, putRoomSelections, type ApiResult } from './api.js';
import { extractRoomDisplayName } from './rooms.js';
import { DEFAULT_COLOR, mergeSelectionsForViewer } from './selections.js';
import { readItem, removeItem, writeItem } from './storage.js';
import type { RoomSelection, SelectionMap, SelectionState } from './types.js';

/** How often the room is re-read while the tab is visible. */
export const POLL_INTERVAL_MS = 10_000;
/** How long after the last pick a write waits, so a burst of taps is one request. */
export const PUT_DEBOUNCE_MS = 500;

const ROOM_PREFIX = 'stagehopper';

export interface RoomSyncDeps {
	api: {
		fetchRoomSelections: (roomId: string) => Promise<ApiResult<RoomSelection[]>>;
		putRoomSelections: (
			roomId: string,
			payload: { name: string; color: string; selections: SelectionMap; festivalId?: string }
		) => Promise<ApiResult<unknown>>;
	};
	store: {
		readItem: (key: string) => string | null;
		writeItem: (key: string, value: string) => void;
		removeItem: (key: string) => void;
		/** Every stored key, for the sign-out sweep. Absent when the store can't enumerate. */
		keys?: () => string[];
	};
	isOnline: () => boolean;
	isHidden: () => boolean;
	/** Which festival to index a write under; a custom-slug room carries none in its id. */
	festivalId: () => string | undefined;
	/** The gateway rejected a write: the session is gone. Sync stops retrying until `write()`. */
	onUnauthorized: () => void;
}

export const defaultRoomSyncDeps: Omit<RoomSyncDeps, 'festivalId' | 'onUnauthorized'> = {
	api: { fetchRoomSelections, putRoomSelections },
	store: {
		readItem,
		writeItem,
		removeItem,
		keys: () => {
			try {
				if (typeof localStorage === 'undefined') return [];
				const out: string[] = [];
				for (let i = 0; i < localStorage.length; i++) {
					const key = localStorage.key(i);
					if (key) out.push(key);
				}
				return out;
			} catch {
				return [];
			}
		}
	},
	isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
	isHidden: () => typeof document !== 'undefined' && document.hidden
};

interface MySnapshot {
	selections: SelectionMap;
	pendingWrite: boolean;
}

/** A one-word summary of where the room stands, for a status pill or a test assertion. */
export type SyncStatus = 'synced' | 'pending' | 'offline' | 'error';

export class RoomSync {
	#deps: RoomSyncDeps;

	// ---- Synced state ----
	roomId = $state('');
	userId = $state('');
	myName = $state('');
	myColor = $state(DEFAULT_COLOR);
	mySelections = $state<SelectionMap>({});
	/** Everyone else's picks, as last read from the server or restored from the snapshot. */
	otherSelections = $state<RoomSelection[]>([]);
	/** This room's custom display name, if the creator set one — see extractRoomDisplayName. */
	roomDisplayName = $state<string | null>(null);

	// ---- Status ----
	/**
	 * Read and write failures are tracked apart, so a save that lands late cannot clear an
	 * error the other half of the sync loop just raised.
	 */
	readError = $state('');
	writeError = $state('');
	/** True while a local edit has not yet been acknowledged by the backend. */
	hasPendingWrite = $state(false);

	/**
	 * Everyone in the room, the viewer included, folded together from the fields that own
	 * each part.
	 */
	allSelections: RoomSelection[] = $derived([
		...this.otherSelections,
		{ userId: this.userId, name: this.myName, color: this.myColor, selections: this.mySelections }
	]);

	/**
	 * One word for where the room stands. Order matters:
	 *
	 * - `offline` outranks `pending`, because the copy already promises the queued pick
	 *   will sync on reconnect — the connection is the fact worth surfacing, not the queue.
	 * - `error` means a *write* failed. A `readError` alone leaves the room usable and its
	 *   picks safe, so it does not make the room's state an error.
	 * - `pending` is true for about half a second on every pick, so it must rank last.
	 *
	 * `isOnline()` is a plain read, not a reactive signal: this recomputes when an error or
	 * the pending flag changes, not the instant the radio drops. Good enough, because every
	 * transition that matters here is triggered by a read or write resolving anyway.
	 */
	status: SyncStatus = $derived.by(() => {
		if (!this.#deps.isOnline()) return 'offline';
		if (this.writeError) return 'error';
		if (this.hasPendingWrite) return 'pending';
		return 'synced';
	});

	// ---- Internals ----
	/**
	 * Incremented on every `reset`. Async steps compare against it before writing state, so a
	 * fast room switch can't be overwritten by the previous room's in-flight response.
	 */
	#loadToken = 0;
	#putTimer: ReturnType<typeof setTimeout> | null = null;
	#pollTimer: ReturnType<typeof setInterval> | null = null;
	#disposed = false;
	/**
	 * Incremented per save. A save that finishes after a newer one started must not report
	 * its outcome — otherwise a slow success can clear the error a later, failed save raised.
	 */
	#writeSeq = 0;
	/** Read errors only show after 2 consecutive failures, so one poll hiccup doesn't strobe. */
	#consecutiveReadFailures = 0;
	#onVisibilityChange = () => {
		if (this.#deps.isHidden()) this.flush();
		else void this.refresh();
	};
	#onPageHide = () => this.flush();

	constructor(deps: RoomSyncDeps) {
		this.#deps = deps;
		// A debounced pick must not be lost when the tab is backgrounded or closed. Polling
		// pauses while hidden, so coming back also needs an immediate catch-up read.
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', this.#onVisibilityChange);
		}
		if (typeof window !== 'undefined') window.addEventListener('pagehide', this.#onPageHide);
	}

	// ---- Lifecycle ----

	/**
	 * Point at a room and viewer, dropping the previous room's data. Seeds `mySelections`
	 * from an unsynced snapshot when the last session closed with a write still owing.
	 */
	reset(roomId: string, userId: string): void {
		this.#loadToken++;
		this.#cancelPendingPut();
		this.stopPolling();
		this.roomId = roomId;
		this.userId = userId;
		this.myName = '';
		this.myColor = DEFAULT_COLOR;
		// Carrying picks across a switch would make the previous room's selections the local
		// snapshot for this one — mergeSelectionsForViewer treats a non-empty viewer entry as
		// authoritative — and the next toggle would write them into this room.
		this.mySelections = {};
		this.otherSelections = [];
		this.roomDisplayName = null;
		this.readError = '';
		this.writeError = '';
		this.hasPendingWrite = false;
		this.#consecutiveReadFailures = 0;

		if (!userId) return;
		const mySnap = this.#loadMySnapshot();
		if (mySnap?.pendingWrite) {
			this.mySelections = mySnap.selections;
			this.hasPendingWrite = true;
		}
	}

	/**
	 * First read after {@link reset}: refresh from the server, or when that fails hydrate
	 * everyone's picks from the last snapshot so the room isn't blank. Starts polling.
	 * Returns whether the viewer is already a member of this room, answered by the server
	 * when it could be reached and by the snapshot otherwise — without that fallback the
	 * join modal would open on any read hiccup, and confirming it would overwrite the picks
	 * just restored.
	 */
	async load(): Promise<{ knownMember: boolean }> {
		const token = this.#loadToken;
		const result = await this.refresh({ preferRemoteColor: true });
		if (token !== this.#loadToken || this.#disposed) return { knownMember: false };

		let knownMember = result.remoteViewerFound;
		if (result.readFailed) {
			const allSnap = this.#loadAllSnapshot();
			if (allSnap) {
				const merged = mergeSelectionsForViewer(allSnap, this.#viewer(), {
					preferRemoteColor: true
				});
				this.otherSelections = merged.otherSelections;
				this.myColor = merged.viewerColor;
				knownMember = merged.remoteViewerFound;
			}
		}
		this.startPolling();
		return { knownMember };
	}

	startPolling(): void {
		this.stopPolling();
		if (this.#disposed) return;
		this.#pollTimer = setInterval(() => {
			// Skip polling a room nobody is looking at; the next foreground tick catches up.
			if (this.#deps.isHidden()) return;
			// Retry a failed write on the polling tick if no newer write is pending.
			if (this.hasPendingWrite && !this.#putTimer) void this.#write();
			void this.refresh();
		}, POLL_INTERVAL_MS);
	}

	stopPolling(): void {
		if (this.#pollTimer) clearInterval(this.#pollTimer);
		this.#pollTimer = null;
	}

	/** Tear down timers and listeners. Any unsaved edit dies with the instance. */
	dispose(): void {
		this.#disposed = true;
		this.stopPolling();
		this.#cancelPendingPut();
		// A later flush would write picks into a room this viewer may have already left.
		this.hasPendingWrite = false;
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', this.#onVisibilityChange);
		}
		if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.#onPageHide);
	}

	// ---- Reads ----

	/** Re-read the room from the backend and merge it with local edits. */
	async refresh(options: { preferRemoteColor?: boolean } = {}): Promise<{
		remoteViewerFound: boolean;
		readFailed: boolean;
	}> {
		const roomId = this.roomId;
		const userId = this.userId;
		if (!roomId || !userId) return { remoteViewerFound: false, readFailed: false };

		const result = await this.#deps.api.fetchRoomSelections(roomId);
		// The viewer moved rooms (or signed out) while this was in flight; applying it now
		// would hydrate one room's picks into another.
		if (roomId !== this.roomId || userId !== this.userId || this.#disposed) {
			return { remoteViewerFound: false, readFailed: false };
		}
		if (!result.ok) {
			this.#consecutiveReadFailures++;
			if (this.#consecutiveReadFailures >= 2) {
				this.readError = this.#deps.isOnline()
					? "Couldn't reach the server — retrying…"
					: 'Weak connection — showing your last synced picks.';
			}
			return { remoteViewerFound: false, readFailed: true };
		}

		this.#consecutiveReadFailures = 0;
		const { participants, displayName } = extractRoomDisplayName(result.data);
		if (displayName) this.roomDisplayName = displayName;
		const merged = mergeSelectionsForViewer(participants, this.#viewer(), {
			preferRemoteColor: options.preferRemoteColor
		});
		this.mySelections = merged.viewerSelections;
		this.myColor = merged.viewerColor;
		this.myName = merged.viewerName;
		this.otherSelections = merged.otherSelections;
		this.#saveAllSnapshot();
		this.readError = '';
		return { remoteViewerFound: merged.remoteViewerFound, readFailed: false };
	}

	// ---- Writes ----

	/** A local pick. Persisted at once so it survives a reload; written after a debounce. */
	setSelection(performanceId: string, state: SelectionState): void {
		this.mySelections = { ...this.mySelections, [performanceId]: state };
		this.hasPendingWrite = true;
		this.#saveMySnapshot(true);
		if (this.#putTimer) clearTimeout(this.#putTimer);
		this.#putTimer = setTimeout(() => {
			this.#putTimer = null;
			void this.#write();
		}, PUT_DEBOUNCE_MS);
	}

	/** The viewer's name and colour, as chosen in the join modal. Does not write by itself. */
	setIdentity(name: string, color: string): void {
		this.myName = name;
		this.myColor = color;
	}

	/** Write now, bypassing the debounce — after a join, or a re-auth that cleared a 401. */
	write(): Promise<void> {
		this.writeError = '';
		return this.#write();
	}

	/**
	 * Write out any debounced edit immediately — when the page is being hidden or unloaded,
	 * where waiting out the debounce would silently drop the last pick.
	 */
	flush(): void {
		if (!this.hasPendingWrite || this.#disposed) return;
		this.#cancelPendingPut();
		void this.#write();
	}

	/** Drop an unsaved edit without writing it — before leaving the room. */
	discardPending(): void {
		this.#cancelPendingPut();
		this.hasPendingWrite = false;
	}

	async #write(): Promise<void> {
		if (!this.roomId || !this.userId || !this.myName) return;

		const seq = ++this.#writeSeq;
		const festivalId = this.#deps.festivalId();
		const result = await this.#deps.api.putRoomSelections(this.roomId, {
			name: this.myName,
			color: this.myColor,
			selections: this.mySelections,
			...(festivalId ? { festivalId } : {})
		});
		if (seq !== this.#writeSeq || this.#disposed) return;

		if (result.ok) {
			// An edit made while this request was in flight has its own debounce timer still
			// owing a write. Clearing the flag here would make flush() a no-op, and a page
			// frozen on backgrounding would drop that edit.
			if (!this.#putTimer) {
				this.hasPendingWrite = false;
				this.#saveMySnapshot(false);
			}
			this.writeError = '';
			return;
		}
		if (result.unauthorized) {
			this.writeError = 'Save failed — signed out.';
			this.#deps.onUnauthorized();
			return;
		}
		this.writeError = this.#deps.isOnline()
			? "Couldn't save — retrying…"
			: "Weak connection — your picks will sync when you're back.";
	}

	#cancelPendingPut(): void {
		if (this.#putTimer) clearTimeout(this.#putTimer);
		this.#putTimer = null;
	}

	#viewer(): RoomSelection {
		return {
			userId: this.userId,
			name: this.myName,
			color: this.myColor,
			selections: this.mySelections
		};
	}

	// ---- Offline snapshots ----

	#key(kind: 'mySnapshot' | 'allSnapshot'): string {
		return `${ROOM_PREFIX}:${this.roomId}:${kind}`;
	}

	#saveMySnapshot(pendingWrite: boolean): void {
		this.#deps.store.writeItem(
			this.#key('mySnapshot'),
			JSON.stringify({ selections: this.mySelections, pendingWrite })
		);
	}

	#loadMySnapshot(): MySnapshot | null {
		const raw = this.#deps.store.readItem(this.#key('mySnapshot'));
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw) as Record<string, unknown> | null;
			if (
				parsed &&
				typeof parsed === 'object' &&
				typeof parsed.selections === 'object' &&
				parsed.selections !== null &&
				typeof parsed.pendingWrite === 'boolean'
			) {
				return parsed as unknown as MySnapshot;
			}
			return null;
		} catch {
			return null;
		}
	}

	#saveAllSnapshot(): void {
		this.#deps.store.writeItem(this.#key('allSnapshot'), JSON.stringify(this.allSelections));
	}

	#loadAllSnapshot(): RoomSelection[] | null {
		const raw = this.#deps.store.readItem(this.#key('allSnapshot'));
		if (!raw) return null;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (
				Array.isArray(parsed) &&
				parsed.every(
					(item) =>
						item &&
						typeof item === 'object' &&
						typeof (item as Record<string, unknown>).userId === 'string' &&
						typeof (item as Record<string, unknown>).name === 'string' &&
						typeof (item as Record<string, unknown>).color === 'string' &&
						typeof (item as Record<string, unknown>).selections === 'object'
				)
			) {
				return parsed as RoomSelection[];
			}
			return null;
		} catch {
			return null;
		}
	}

	/** Drop this room's snapshots — after leaving it. */
	forgetRoom(): void {
		this.#deps.store.removeItem(this.#key('mySnapshot'));
		this.#deps.store.removeItem(this.#key('allSnapshot'));
	}

	/** Drop every room's snapshots — on sign-out, so the next account starts clean. */
	static forgetAllRooms(store: RoomSyncDeps['store'] = defaultRoomSyncDeps.store): void {
		const pattern = /^stagehopper:.*:(mySnapshot|allSnapshot)$/;
		for (const key of store.keys?.() ?? []) {
			if (pattern.test(key)) store.removeItem(key);
		}
	}
}
