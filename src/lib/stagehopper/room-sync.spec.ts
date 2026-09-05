import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUT_DEBOUNCE_MS, POLL_INTERVAL_MS, RoomSync, type RoomSyncDeps } from './room-sync.svelte.js';
import type { ApiResult } from './api.js';
import type { RoomSelection, SelectionMap } from './types.js';

/**
 * The seam in use: an in-memory store and a scripted API, so the invariants that used to be
 * unreachable — write sequencing, the two-failure read debounce, "clear the pending flag only
 * if no newer timer is owing" — can be driven by resolving promises in a chosen order rather
 * than by routing a fetch stub on URL substrings.
 */
function ok<T>(data: T): ApiResult<T> {
	return { ok: true, data };
}
function fail(unauthorized = false): ApiResult<never> {
	return { ok: false, unauthorized, status: unauthorized ? 401 : 500 };
}

const VIEWER = 'clerk:u1';

function makeDeps(overrides: Partial<RoomSyncDeps> = {}) {
	const store = new Map<string, string>();
	const reads: Array<(result: ApiResult<RoomSelection[]>) => void> = [];
	const writes: Array<{ payload: unknown; settle: (result: ApiResult<unknown>) => void }> = [];
	const onUnauthorized = vi.fn();
	let online = true;
	let hidden = false;

	const deps: RoomSyncDeps = {
		api: {
			fetchRoomSelections: () =>
				new Promise<ApiResult<RoomSelection[]>>((resolve) => reads.push(resolve)),
			putRoomSelections: (_roomId, payload) =>
				new Promise<ApiResult<unknown>>((settle) => writes.push({ payload, settle }))
		},
		store: {
			readItem: (key) => store.get(key) ?? null,
			writeItem: (key, value) => void store.set(key, value),
			removeItem: (key) => void store.delete(key),
			keys: () => [...store.keys()]
		},
		isOnline: () => online,
		isHidden: () => hidden,
		festivalId: () => 'tmr26',
		onUnauthorized,
		...overrides
	};

	return {
		deps,
		store,
		onUnauthorized,
		/** Settle the oldest outstanding read. */
		answerRead: (result: ApiResult<RoomSelection[]>) => reads.shift()?.(result),
		/** Settle the oldest outstanding write. */
		answerWrite: (result: ApiResult<unknown> = ok({})) => writes.shift()?.settle(result),
		writes,
		reads,
		setOnline: (value: boolean) => void (online = value),
		setHidden: (value: boolean) => void (hidden = value)
	};
}

function participant(userId: string, selections: SelectionMap = {}): RoomSelection {
	return { userId, name: userId === VIEWER ? 'Me' : 'Sam', color: '#e74c3c', selections };
}

/** Let queued microtasks run, so an awaited promise's continuations land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('RoomSync', () => {
	beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
	afterEach(() => vi.useRealTimers());

	describe('opening a room', () => {
		it('restores an unsynced snapshot and keeps it pending', () => {
			const h = makeDeps();
			h.store.set(
				'stagehopper:tmr26-a1:mySnapshot',
				JSON.stringify({ selections: { p1: 1 }, pendingWrite: true })
			);
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);

			expect(sync.mySelections).toEqual({ p1: 1 });
			expect(sync.hasPendingWrite).toBe(true);
			sync.dispose();
		});

		it('ignores a snapshot that was already synced', () => {
			const h = makeDeps();
			h.store.set(
				'stagehopper:tmr26-a1:mySnapshot',
				JSON.stringify({ selections: { p1: 1 }, pendingWrite: false })
			);
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);

			expect(sync.mySelections).toEqual({});
			expect(sync.hasPendingWrite).toBe(false);
			sync.dispose();
		});

		it('drops the previous room’s picks on a switch', async () => {
			const h = makeDeps();
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);
			sync.setIdentity('Me', '#e74c3c');
			sync.setSelection('p1', 1);

			sync.reset('tmr26-b2', VIEWER);

			expect(sync.mySelections).toEqual({});
			expect(sync.otherSelections).toEqual([]);
			expect(sync.hasPendingWrite).toBe(false);
			sync.dispose();
		});

		it('falls back to the all-participants snapshot when the first read fails', async () => {
			const h = makeDeps();
			h.store.set(
				'stagehopper:tmr26-a1:allSnapshot',
				JSON.stringify([participant('clerk:u2', { p1: 2 }), participant(VIEWER, { p9: 1 })])
			);
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);

			const loading = sync.load();
			h.answerRead(fail());
			const { knownMember } = await loading;

			// The snapshot answers "already joined?" just as well as the network would have.
			expect(knownMember).toBe(true);
			expect(sync.otherSelections).toEqual([participant('clerk:u2', { p1: 2 })]);
			sync.dispose();
		});
	});

	describe('reads', () => {
		it('shows a read error only after two consecutive failures', async () => {
			const h = makeDeps();
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);

			const first = sync.refresh();
			h.answerRead(fail());
			await first;
			expect(sync.readError).toBe('');

			const second = sync.refresh();
			h.answerRead(fail());
			await second;
			expect(sync.readError).toMatch(/couldn't reach the server/i);
			sync.dispose();
		});

		it('names weak connection rather than the server when offline', async () => {
			const h = makeDeps();
			h.setOnline(false);
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);

			for (let i = 0; i < 2; i++) {
				const pending = sync.refresh();
				h.answerRead(fail());
				await pending;
			}

			expect(sync.readError).toMatch(/weak connection/i);
			sync.dispose();
		});

		it('clears the error and the failure count on a successful read', async () => {
			const h = makeDeps();
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);

			for (let i = 0; i < 2; i++) {
				const pending = sync.refresh();
				h.answerRead(fail());
				await pending;
			}
			const recover = sync.refresh();
			h.answerRead(ok([participant('clerk:u2', { p1: 1 })]));
			await recover;

			expect(sync.readError).toBe('');
			expect(sync.otherSelections).toEqual([participant('clerk:u2', { p1: 1 })]);
			sync.dispose();
		});

		it('discards a response that lands after the viewer switched rooms', async () => {
			const h = makeDeps();
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);

			const inFlight = sync.refresh();
			sync.reset('tmr26-b2', VIEWER);
			h.answerRead(ok([participant('clerk:u2', { p1: 1 })]));
			await inFlight;

			expect(sync.otherSelections).toEqual([]);
			sync.dispose();
		});
	});

	describe('writes', () => {
		it('coalesces a burst of picks into one debounced write', async () => {
			const h = makeDeps();
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);
			sync.setIdentity('Me', '#e74c3c');

			sync.setSelection('p1', 1);
			sync.setSelection('p2', 1);
			sync.setSelection('p3', 2);
			expect(h.writes).toHaveLength(0);

			vi.advanceTimersByTime(PUT_DEBOUNCE_MS);
			await settle();

			expect(h.writes).toHaveLength(1);
			expect(h.writes[0]?.payload).toMatchObject({
				selections: { p1: 1, p2: 1, p3: 2 },
				festivalId: 'tmr26'
			});
			sync.dispose();
		});

		it('persists each pick immediately, before the write goes out', () => {
			const h = makeDeps();
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);
			sync.setIdentity('Me', '#e74c3c');

			sync.setSelection('p1', 1);

			expect(JSON.parse(h.store.get('stagehopper:tmr26-a1:mySnapshot') ?? '{}')).toEqual({
				selections: { p1: 1 },
				pendingWrite: true
			});
			sync.dispose();
		});

		it('keeps the edit pending when a newer one is owing a write', async () => {
			const h = makeDeps();
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);
			sync.setIdentity('Me', '#e74c3c');

			sync.setSelection('p1', 1);
			vi.advanceTimersByTime(PUT_DEBOUNCE_MS);
			await settle();
			// A second edit arrives while the first request is still in flight.
			sync.setSelection('p2', 1);
			h.answerWrite(ok({}));
			await settle();

			// Clearing the flag here would make a flush on backgrounding a no-op.
			expect(sync.hasPendingWrite).toBe(true);
			sync.dispose();
		});

		it('does not let a slow success clear an error a newer write raised', async () => {
			const h = makeDeps();
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);
			sync.setIdentity('Me', '#e74c3c');

			void sync.write();
			void sync.write();
			// Settle the newer write first, with a failure, then the older one with a success.
			h.writes[1]?.settle(fail());
			await settle();
			h.writes[0]?.settle(ok({}));
			await settle();

			expect(sync.writeError).toMatch(/couldn't save/i);
			sync.dispose();
		});

		it('reports an expired session once and stops there', async () => {
			const h = makeDeps();
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);
			sync.setIdentity('Me', '#e74c3c');

			void sync.write();
			h.answerWrite(fail(true));
			await settle();

			expect(h.onUnauthorized).toHaveBeenCalledOnce();
			expect(sync.writeError).toMatch(/signed out/i);
			sync.dispose();
		});

		it('flushes a debounced pick immediately', async () => {
			const h = makeDeps();
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);
			sync.setIdentity('Me', '#e74c3c');

			sync.setSelection('p1', 1);
			sync.flush();
			await settle();

			expect(h.writes).toHaveLength(1);
			sync.dispose();
		});

		it('marks the snapshot synced once the write lands', async () => {
			const h = makeDeps();
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);
			sync.setIdentity('Me', '#e74c3c');

			sync.setSelection('p1', 1);
			vi.advanceTimersByTime(PUT_DEBOUNCE_MS);
			await settle();
			h.answerWrite(ok({}));
			await settle();

			expect(sync.hasPendingWrite).toBe(false);
			expect(JSON.parse(h.store.get('stagehopper:tmr26-a1:mySnapshot') ?? '{}')).toEqual({
				selections: { p1: 1 },
				pendingWrite: false
			});
			sync.dispose();
		});

		it('does not write before the viewer has a name', async () => {
			const h = makeDeps();
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);

			sync.setSelection('p1', 1);
			vi.advanceTimersByTime(PUT_DEBOUNCE_MS);
			await settle();

			expect(h.writes).toHaveLength(0);
			sync.dispose();
		});

		it('discardPending drops an unsaved edit without writing it', async () => {
			const h = makeDeps();
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);
			sync.setIdentity('Me', '#e74c3c');

			sync.setSelection('p1', 1);
			sync.discardPending();
			vi.advanceTimersByTime(PUT_DEBOUNCE_MS);
			await settle();

			expect(h.writes).toHaveLength(0);
			expect(sync.hasPendingWrite).toBe(false);
			sync.dispose();
		});
	});

	describe('polling', () => {
		it('skips a tick while the tab is hidden', () => {
			const h = makeDeps();
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);
			sync.startPolling();

			h.setHidden(true);
			vi.advanceTimersByTime(POLL_INTERVAL_MS);
			expect(h.reads).toHaveLength(0);

			h.setHidden(false);
			vi.advanceTimersByTime(POLL_INTERVAL_MS);
			expect(h.reads).toHaveLength(1);
			sync.dispose();
		});

		it('retries a pending write on the tick', async () => {
			const h = makeDeps();
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);
			sync.setIdentity('Me', '#e74c3c');
			sync.startPolling();

			sync.setSelection('p1', 1);
			vi.advanceTimersByTime(PUT_DEBOUNCE_MS);
			await settle();
			h.answerWrite(fail());
			await settle();
			expect(sync.hasPendingWrite).toBe(true);

			vi.advanceTimersByTime(POLL_INTERVAL_MS);
			await settle();

			expect(h.writes).toHaveLength(1);
			sync.dispose();
		});

		it('stops every timer on dispose', async () => {
			const h = makeDeps();
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);
			sync.setIdentity('Me', '#e74c3c');
			sync.startPolling();
			sync.setSelection('p1', 1);

			sync.dispose();
			vi.advanceTimersByTime(POLL_INTERVAL_MS + PUT_DEBOUNCE_MS);
			await settle();

			expect(h.reads).toHaveLength(0);
			expect(h.writes).toHaveLength(0);
			// A later flush would write picks into a room the viewer may have left.
			expect(sync.hasPendingWrite).toBe(false);
		});
	});

	describe('status', () => {
		it('is synced on a quiet, connected room', () => {
			const h = makeDeps();
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);

			expect(sync.status).toBe('synced');
			sync.dispose();
		});

		it('is pending while a pick is owing a write', () => {
			const h = makeDeps();
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);
			sync.setIdentity('Me', '#e74c3c');

			sync.setSelection('p1', 1);

			expect(sync.status).toBe('pending');
			sync.dispose();
		});

		it('reports offline ahead of a queued pick', () => {
			const h = makeDeps();
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);
			sync.setIdentity('Me', '#e74c3c');

			sync.setSelection('p1', 1);
			h.setOnline(false);

			// The copy already promises the pick syncs on reconnect; the connection is the fact.
			expect(sync.status).toBe('offline');
			sync.dispose();
		});

		it('is an error only when a write failed, not a read', async () => {
			const h = makeDeps();
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);
			sync.setIdentity('Me', '#e74c3c');

			for (let i = 0; i < 2; i++) {
				const pending = sync.refresh();
				h.answerRead(fail());
				await pending;
			}
			expect(sync.readError).not.toBe('');
			// A failed read leaves the room usable and its picks safe.
			expect(sync.status).toBe('synced');

			void sync.write();
			h.answerWrite(fail());
			await settle();

			expect(sync.status).toBe('error');
			sync.dispose();
		});
	});

	describe('forgetting rooms', () => {
		it('clears both snapshot keys for the current room', () => {
			const h = makeDeps();
			h.store.set('stagehopper:tmr26-a1:mySnapshot', '{}');
			h.store.set('stagehopper:tmr26-a1:allSnapshot', '[]');
			h.store.set('stagehopper:tmr26-a1:favStages', '[]');
			const sync = new RoomSync(h.deps);
			sync.reset('tmr26-a1', VIEWER);

			sync.forgetRoom();

			expect(h.store.has('stagehopper:tmr26-a1:mySnapshot')).toBe(false);
			expect(h.store.has('stagehopper:tmr26-a1:allSnapshot')).toBe(false);
			// Favourites are a device preference, not synced room data.
			expect(h.store.has('stagehopper:tmr26-a1:favStages')).toBe(true);
			sync.dispose();
		});

		it('sweeps every room’s snapshots on sign-out', () => {
			const h = makeDeps();
			h.store.set('stagehopper:tmr26-a1:mySnapshot', '{}');
			h.store.set('stagehopper:tmr26-b2:allSnapshot', '[]');
			h.store.set('stagehopper:tmr26-a1:identity', '{}');

			RoomSync.forgetAllRooms(h.deps.store);

			expect([...h.store.keys()]).toEqual(['stagehopper:tmr26-a1:identity']);
		});
	});
});
