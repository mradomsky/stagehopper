import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationSettings } from './api.js';

/**
 * Clerk, reduced to what this file exercises: who is signed in, and whether a request can
 * be signed. `api.ts` imports the same module, so setting `session.user` here is what makes
 * its calls carry a token — exactly as a real session would.
 */
const session = vi.hoisted(() => ({
	user: null as { id: string; name: string; givenName: string } | null
}));

vi.mock('./auth.svelte.js', () => ({
	auth: session,
	loadAuth: async () => null,
	getApiToken: async () => (session.user ? 'clerk-jwt' : null),
	signOut: async () => {
		session.user = null;
	}
}));

import { RoomState } from './room-state.svelte.js';
import { loadFavouriteStages } from './storage.js';
import { timeToGridMin } from './time.js';
import type { RoomSelection } from './types.js';
import tmr26Timetable from '../../test-support/fixtures/timetable-tmr26.json';
import ps26Timetable from '../../test-support/fixtures/timetable-ps26.json';

const ROOM_ID = 'tmr26-abc123';
const VIEWER_ID = 'clerk:123';

const fetchMock = vi.fn();
const navigate = vi.fn();

function jsonResponse(body: unknown, status = 200) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/**
 * Both the room-selections GET and the timetable GET are bodyless (`init` is
 * undefined), so this routes by URL rather than by presence of `init`.
 */
function timetableResponseFor(url: string) {
	if (url.includes('festivals/tmr26/timetable')) return jsonResponse(tmr26Timetable);
	if (url.includes('festivals/ps26/timetable')) return jsonResponse(ps26Timetable);
	return jsonResponse({ formatVersion: 1, festivalId: 'unknown', days: [] }, 404);
}

/**
 * Reply to a GET of the room's selections; every other call succeeds emptily. Also accepts
 * a room-name row (`{ userId: '@room', displayName }`) mixed in, since that's a real shape
 * the wire format carries — see extractRoomDisplayName.
 */
function respondWithSelections(selections: (RoomSelection | { userId: string; displayName: string })[]) {
	fetchMock.mockImplementation((url: string, init?: RequestInit) => {
		if (typeof url === 'string' && url.includes('/timetable.json')) {
			return Promise.resolve(timetableResponseFor(url));
		}
		if (!init) return Promise.resolve(jsonResponse(selections));
		return Promise.resolve(jsonResponse({ ok: true }));
	});
}

/**
 * Like {@link respondWithSelections}, plus a canned reply for the notifications route:
 * the settings fetch (a bodyless-looking POST, per api.ts's `getNotificationSettings`)
 * returns `settings`; a PUT (an override write) succeeds emptily unless `putImpl` says
 * otherwise, so tests can simulate a failed bell write.
 */
function respondWithSelectionsAndNotifications(
	selections: RoomSelection[],
	settings: Partial<NotificationSettings> = {},
	putImpl?: (url: string, init: RequestInit) => unknown
) {
	const full: NotificationSettings = {
		leadMinutes: 15,
		notifyMaybe: false,
		notifyOverrides: {},
		enabled: true,
		subscribedHere: false,
		...settings
	};
	fetchMock.mockImplementation((url: string, init?: RequestInit) => {
		if (typeof url === 'string' && url.includes('/timetable.json')) {
			return Promise.resolve(timetableResponseFor(url));
		}
		if (typeof url === 'string' && url.includes('/users/me/notifications')) {
			if (init?.method === 'PUT') {
				return Promise.resolve(putImpl ? putImpl(url, init) : jsonResponse({ ok: true }));
			}
			return Promise.resolve(jsonResponse(full));
		}
		if (!init) return Promise.resolve(jsonResponse(selections));
		return Promise.resolve(jsonResponse({ ok: true }));
	});
}

function signIn(id = '123') {
	session.user = { id, name: 'Alex Example', givenName: 'Alex' };
}

function createRoom() {
	return new RoomState({ navigate });
}

beforeEach(() => {
	session.user = null;
	fetchMock.mockReset();
	navigate.mockReset();
	vi.stubGlobal('fetch', fetchMock);
	respondWithSelections([]);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('bootstrap', () => {
	it('sends a signed-out visitor to the landing page, remembering the room', async () => {
		const room = createRoom();

		await room.bootstrap(ROOM_ID);

		expect(navigate).toHaveBeenCalledWith(`/?next=${encodeURIComponent(ROOM_ID)}`);
		room.dispose();
	});

	it('opens the join modal when the backend has never seen this participant', async () => {
		signIn();
		const room = createRoom();

		await room.bootstrap(ROOM_ID);

		expect(room.joinModalOpen).toBe(true);
		expect(room.joinName).toBe('Alex');
		expect(room.userId).toBe(VIEWER_ID);
		room.dispose();
	});

	it('skips the join modal for a participant the backend already knows', async () => {
		signIn();
		respondWithSelections([
			{ userId: VIEWER_ID, name: 'Alex', color: '#3498db', selections: { p1: 1 } }
		]);
		const room = createRoom();

		await room.bootstrap(ROOM_ID);

		expect(room.joinModalOpen).toBe(false);
		expect(room.myName).toBe('Alex');
		expect(room.myColor).toBe('#3498db');
		expect(room.mySelections).toEqual({ p1: 1 });
		room.dispose();
	});

	it('treats a bare festival id as read-only guest browsing', async () => {
		const room = createRoom();

		await room.bootstrap('tmr26');

		expect(room.isGuestMode).toBe(true);
		expect(room.joinModalOpen).toBe(false);
		expect(navigate).not.toHaveBeenCalled();
		expect(room.timetable.days.length).toBeGreaterThan(0);
		room.dispose();
	});

	it('does not let a slow response from the previous room overwrite the new one', async () => {
		signIn();
		const room = createRoom();

		// Hold the first room's *selections* response open until after the second room
		// has loaded. Matched by URL, not call order — bootstrap also fires a concurrent
		// timetable fetch, so "the next call" isn't reliably the selections one.
		let releaseFirstFetch!: () => void;
		const firstFetchGate = new Promise<void>((resolve) => {
			releaseFirstFetch = resolve;
		});
		fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url.includes('/timetable.json')) return timetableResponseFor(url);
			if (!init && url.includes(ROOM_ID)) {
				await firstFetchGate;
				return jsonResponse([
					{ userId: VIEWER_ID, name: 'Stale', color: '#e74c3c', selections: { old: 1 } }
				]);
			}
			if (!init) return jsonResponse([]);
			return jsonResponse({ ok: true });
		});

		const firstBootstrap = room.bootstrap(ROOM_ID);
		await room.bootstrap('tmr26-def456');

		releaseFirstFetch();
		await firstBootstrap;

		expect(room.roomId).toBe('tmr26-def456');
		expect(room.myName).not.toBe('Stale');
		expect(room.mySelections).toEqual({});
		expect(room.allSelections.some((s) => Object.keys(s.selections).length > 0)).toBe(false);
		room.dispose();
	});

	it('discards a poll response that arrives after the viewer changed rooms', async () => {
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);

		let releasePoll!: () => void;
		const pollGate = new Promise<void>((resolve) => {
			releasePoll = resolve;
		});
		fetchMock.mockImplementationOnce(async () => {
			await pollGate;
			return jsonResponse([
				{ userId: VIEWER_ID, name: 'Alex', color: '#e74c3c', selections: { fromOldRoom: 1 } }
			]);
		});

		const pending = room.refresh();
		await room.bootstrap('tmr26-def456');
		releasePoll();
		await pending;

		expect(room.mySelections).toEqual({});
		room.dispose();
	});
});

describe('marking performances', () => {
	it('cycles a performance through going and maybe, then writes after the debounce', async () => {
		vi.useFakeTimers();
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.confirmJoin();
		await vi.advanceTimersByTimeAsync(600);
		fetchMock.mockClear();

		room.togglePerformance('p1');
		expect(room.myState('p1')).toBe(1);
		room.togglePerformance('p1');
		expect(room.myState('p1')).toBe(2);

		// Coalesced: nothing is written until the debounce elapses.
		expect(fetchMock).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(600);

		const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
		expect(writes).toHaveLength(1);
		expect(JSON.parse(writes[0]?.[1].body).selections).toEqual({ p1: 2 });
		room.dispose();
	});

	it('mirrors the viewer edit into the participant list so the legend stays in sync', async () => {
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.confirmJoin();

		room.togglePerformance('p1');

		const viewerEntry = room.allSelections.find((s) => s.userId === VIEWER_ID);
		expect(viewerEntry?.selections).toEqual({ p1: 1 });
		room.dispose();
	});

	it('writes a pending edit immediately when the page is being hidden', async () => {
		vi.useFakeTimers();
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.confirmJoin();
		await vi.advanceTimersByTimeAsync(600);
		fetchMock.mockClear();

		room.togglePerformance('p1');
		room.flushPendingWrites();
		await vi.advanceTimersByTimeAsync(0);

		expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
		room.dispose();
	});

	it('does not carry picks into the next room on a switch', async () => {
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.confirmJoin();
		room.togglePerformance('p1');
		expect(room.myState('p1')).toBe(1);

		await room.bootstrap('tmr26-def456');

		// Anything left over would become this room's local snapshot and be written into
		// it on the next tap, since a non-empty viewer entry wins the merge.
		expect(room.myState('p1')).toBe(0);
		// The viewer's own entry is synthesized fresh by the merge, so it exists — but empty.
		expect(room.allSelections.find((s) => s.userId === VIEWER_ID)?.selections).toEqual({});
		room.dispose();
	});

	it('still flushes an edit made while an earlier save was in flight', async () => {
		vi.useFakeTimers();
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.confirmJoin();
		await vi.advanceTimersByTimeAsync(0);
		fetchMock.mockClear();

		// Hold the first save open so the second edit is made while it is still in flight.
		let settleFirstPut: (value: unknown) => void = () => {};
		fetchMock.mockImplementationOnce(
			() => new Promise((resolve) => (settleFirstPut = resolve))
		);

		room.togglePerformance('p1');
		await vi.advanceTimersByTimeAsync(600);

		room.togglePerformance('p2');
		settleFirstPut(jsonResponse({ ok: true }));
		await vi.advanceTimersByTimeAsync(0);

		// The page is hidden before p2's own debounce timer gets to fire. The first save
		// completing must not have cleared the pending flag, or p2 is lost on a freeze.
		fetchMock.mockClear();
		room.flushPendingWrites();
		await vi.advanceTimersByTimeAsync(0);

		const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
		expect(puts).toHaveLength(1);
		expect(JSON.parse(String(puts[0]?.[1]?.body)).selections).toEqual({ p1: 1, p2: 1 });
		room.dispose();
	});

	it('drops an unsaved edit once the room page is torn down', async () => {
		vi.useFakeTimers();
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.confirmJoin();
		await vi.advanceTimersByTimeAsync(0);
		fetchMock.mockClear();

		room.togglePerformance('p1');
		room.dispose();
		room.flushPendingWrites();
		await vi.advanceTimersByTimeAsync(1000);

		expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
	});

	it('does not resurrect a room the viewer just left', async () => {
		vi.useFakeTimers();
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.confirmJoin();
		await vi.advanceTimersByTimeAsync(0);

		// A pick that failed to save leaves work pending; leaving must not replay it.
		fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
		room.togglePerformance('p1');
		await vi.advanceTimersByTimeAsync(600);
		fetchMock.mockClear();

		await room.confirmLeaveRoom();
		fetchMock.mockClear();
		room.flushPendingWrites();
		await vi.advanceTimersByTimeAsync(1000);

		expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
		room.dispose();
	});

	it('prompts for re-authentication when the gateway rejects the write', async () => {
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.confirmJoin();

		fetchMock.mockResolvedValue(jsonResponse({ message: 'Unauthorized' }, 401));
		room.togglePerformance('p1');
		room.flushPendingWrites();
		await vi.waitFor(() => expect(room.reauthRequired).toBe(true));

		expect(room.syncError).toMatch(/signed out/i);
		room.dispose();
	});
});

describe('guest mode', () => {
	it('defers a tap to sign-in instead of marking anything', async () => {
		const room = createRoom();
		await room.bootstrap('tmr26');

		room.togglePerformance('p1');

		expect(room.guestSigninOpen).toBe(true);
		expect(room.pendingGuestAction).toEqual({ type: 'perf', performanceId: 'p1' });
		expect(room.mySelections).toEqual({});
		room.dispose();
	});

	it('creates a room and navigates to it once the guest signs in', async () => {
		const room = createRoom();
		await room.bootstrap('tmr26');
		room.requestGuestAction('perf', 'p1');

		signIn();
		await room.createGuestRoomAndNavigate();

		expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/room\/tmr26-[0-9a-f]{6}$/));
		room.dispose();
	});

	it('reports a failure to start a room and lets the guest retry', async () => {
		const room = createRoom();
		await room.bootstrap('tmr26');
		fetchMock.mockResolvedValue(jsonResponse({}, 500));

		await room.createGuestRoomAndNavigate();

		expect(navigate).not.toHaveBeenCalled();
		expect(room.syncError).toMatch(/could not start a room/i);
		expect(room.creatingGuestRoom).toBe(false);
		room.dispose();
	});
});

describe('guest sign-in', () => {
	// Clerk's prebuilt component owns the flow end to end, so the room is told "a session
	// exists now" rather than handed a credential to decode. Every test that used to forge
	// or corrupt an ID token went with that: there is no token here to get wrong.
	it('adopts the identity and replays the action the guest was blocked on', async () => {
		const room = createRoom();
		await room.bootstrap('tmr26');
		room.requestGuestAction('perf', 'p1');

		signIn('999');
		room.handleSignedIn();

		expect(room.userId).toBe('clerk:999');
		expect(room.hasGlobalAuth).toBe(true);
		expect(room.guestSigninOpen).toBe(false);
		expect(room.signInError).toBe('');
		await vi.waitFor(() =>
			expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/room\/tmr26-/))
		);
		room.dispose();
	});

	it('signs the guest in without starting a room when nothing was pending', async () => {
		const room = createRoom();
		await room.bootstrap('tmr26');
		room.openGuestSignin();

		signIn('999');
		room.handleSignedIn();

		expect(room.hasGlobalAuth).toBe(true);
		expect(navigate).not.toHaveBeenCalled();
		room.dispose();
	});

	it('keeps the modal up if it is told of a sign-in that did not happen', async () => {
		const room = createRoom();
		await room.bootstrap('tmr26');
		room.requestGuestAction('perf', 'p1');

		room.handleSignedIn();

		expect(room.signInError).toMatch(/sign-in failed/i);
		expect(room.userId).toBe('');
		expect(navigate).not.toHaveBeenCalled();
		room.dispose();
	});

	it('forgets a pending action when the guest backs out', async () => {
		const room = createRoom();
		await room.bootstrap('tmr26');
		room.requestGuestAction('perf', 'p1');

		room.cancelGuestSignin();

		expect(room.guestSigninOpen).toBe(false);
		expect(room.pendingGuestAction).toBeNull();
		room.dispose();
	});
});

describe('re-authentication', () => {
	/** A room whose request the gateway has just rejected. */
	async function expiredRoom() {
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.confirmJoin();
		await vi.waitFor(() => expect(room.myName).toBeTruthy());

		fetchMock.mockResolvedValue(jsonResponse({ message: 'Unauthorized' }, 401));
		room.togglePerformance('p1');
		room.flushPendingWrites();
		await vi.waitFor(() => expect(room.reauthRequired).toBe(true));
		return room;
	}

	// The picks in this room are keyed to one account. Accepting a different one would write
	// this user's selections under someone else's key, silently.
	it('refuses a different account and stays locked', async () => {
		const room = await expiredRoom();

		signIn('someone-else');
		room.handleReauthenticated();

		expect(room.signInError).toMatch(/same account/i);
		expect(room.reauthRequired).toBe(true);
		room.dispose();
	});

	it('refuses being told of a sign-in that did not happen', async () => {
		const room = await expiredRoom();
		session.user = null;

		room.handleReauthenticated();

		expect(room.signInError).toMatch(/same account/i);
		expect(room.reauthRequired).toBe(true);
		room.dispose();
	});

	it('accepts the same account and retries the save', async () => {
		const room = await expiredRoom();
		respondWithSelections([]);
		fetchMock.mockClear();

		room.handleReauthenticated();

		expect(room.reauthRequired).toBe(false);
		expect(room.signInError).toBe('');

		await vi.waitFor(() => {
			const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
			expect(writes).toHaveLength(1);
			expect(writes[0]?.[1].headers.Authorization).toBe('Bearer clerk-jwt');
		});
		expect(room.syncError).toBe('');
		room.dispose();
	});

	it('keeps the picks made before the session expired', async () => {
		const room = await expiredRoom();
		respondWithSelections([]);

		room.handleReauthenticated();

		expect(room.myState('p1')).toBe(1);
		room.dispose();
	});
});

describe('the Picks tab', () => {
	// The clock below sits at 12:30 on the fixture's second day, so these are, in order:
	// Cici Daze (day 18, 12:00–13:30), Makasi (day 18, 13:00–14:00), Lucas & Steve
	// (day 18, 20:00–21:00), and DJORA — on day 17, a day already finished.
	const NOW_PICK = '2650343511';
	const SOON_PICK = '2934445051';
	const FUTURE_PICK = '2655235930';
	const PAST_DAY_PICK = '3006649694';

	it('groups only marked performances by day, tagged with their timing', async () => {
		vi.setSystemTime(new Date(2026, 6, 18, 12, 30));
		signIn();
		const room = createRoom();
		await room.bootstrap('tmr26-abc123');
		room.confirmJoin();
		room.tickNow();

		for (const id of [NOW_PICK, SOON_PICK, FUTURE_PICK, PAST_DAY_PICK]) {
			room.togglePerformance(id);
		}

		expect(room.pickGroups.map((g) => g.date)).toEqual(['2026-07-17', '2026-07-18']);
		const day18 = room.pickGroups.find((g) => g.date === '2026-07-18');
		const timingById = Object.fromEntries(
			day18?.performances.map((row) => [row.performance.id, row.timing]) ?? []
		);
		expect(timingById[NOW_PICK]).toBe('now');
		expect(timingById[SOON_PICK]).toBe('soon');
		expect(timingById[FUTURE_PICK]).toBe('future');
		expect(room.pickGroups.find((g) => g.date === '2026-07-17')?.performances[0]!.timing).toBe(
			'past'
		);

		vi.useRealTimers();
		room.dispose();
	});

	it('scrolls to the first pick that has not ended yet', async () => {
		vi.setSystemTime(new Date(2026, 6, 18, 12, 30));
		signIn();
		const room = createRoom();
		await room.bootstrap('tmr26-abc123');
		room.confirmJoin();
		room.tickNow();

		room.togglePerformance(PAST_DAY_PICK);
		room.togglePerformance(NOW_PICK);

		expect(room.pickScrollTargetId).toBe(NOW_PICK);

		vi.useRealTimers();
		room.dispose();
	});

	it('has no scroll target once every pick is in the past', async () => {
		vi.setSystemTime(new Date(2026, 6, 18, 12, 30));
		signIn();
		const room = createRoom();
		await room.bootstrap('tmr26-abc123');
		room.confirmJoin();
		room.tickNow();

		room.togglePerformance(PAST_DAY_PICK);

		expect(room.pickScrollTargetId).toBeNull();

		vi.useRealTimers();
		room.dispose();
	});

	it('reports the festival day currently in progress as todayDate', async () => {
		vi.setSystemTime(new Date(2026, 6, 18, 12, 30));
		signIn();
		const room = createRoom();
		await room.bootstrap('tmr26-abc123');
		room.tickNow();

		expect(room.todayDate).toBe('2026-07-18');

		vi.useRealTimers();
		room.dispose();
	});

	it('reclassifies a pick as the clock ticks forward, with no change to the mark itself', async () => {
		vi.setSystemTime(new Date(2026, 6, 18, 12, 30));
		signIn();
		const room = createRoom();
		await room.bootstrap('tmr26-abc123');
		room.confirmJoin();
		room.tickNow();
		room.togglePerformance(SOON_PICK);

		const timingFor = () =>
			room.pickGroups
				.find((g) => g.date === '2026-07-18')
				?.performances.find((row) => row.performance.id === SOON_PICK)?.timing;
		expect(timingFor()).toBe('soon');

		// Makasi runs 13:00–14:00; the tick alone (no new toggle) moves it through
		// 'now' and on to 'past' as the wall clock advances past it.
		vi.setSystemTime(new Date(2026, 6, 18, 13, 15));
		room.tickNow();
		expect(timingFor()).toBe('now');

		vi.setSystemTime(new Date(2026, 6, 18, 14, 15));
		room.tickNow();
		expect(timingFor()).toBe('past');

		vi.useRealTimers();
		room.dispose();
	});
});

describe('notifications', () => {
	const PERF_ID = '3006621839'; // DISCOVERY — tmr26 fixture, day 1.

	it('fetches settings once during bootstrap — the grid bells need it, not just Picks — and does not refetch on Picks open', async () => {
		signIn();
		respondWithSelectionsAndNotifications([], { notifyMaybe: true });
		const room = createRoom();
		await room.bootstrap(ROOM_ID);

		await vi.waitFor(() => expect(room.notificationSettings).not.toBeNull());
		expect(room.notifyMaybeSetting).toBe(true);
		const fetchesAfterBootstrap = fetchMock.mock.calls.filter(([url]) =>
			String(url).includes('/users/me/notifications')
		).length;

		room.setViewMode('picks');
		await Promise.resolve();
		const fetchesAfterPicksOpen = fetchMock.mock.calls.filter(([url]) =>
			String(url).includes('/users/me/notifications')
		).length;

		expect(fetchesAfterBootstrap).toBe(1);
		expect(fetchesAfterPicksOpen).toBe(1);
		room.dispose();
	});

	it('never fetches for a guest — there is no account to have push settings', async () => {
		respondWithSelectionsAndNotifications([]);
		const room = createRoom();
		await room.bootstrap('tmr26');

		room.setViewMode('picks');
		await Promise.resolve();

		expect(
			fetchMock.mock.calls.some(([url]) => String(url).includes('/users/me/notifications'))
		).toBe(false);
		room.dispose();
	});

	it('resets the cache on a room switch, refetching for the new room', async () => {
		signIn();
		respondWithSelectionsAndNotifications([], { notifyMaybe: true });
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		await vi.waitFor(() => expect(room.notifyMaybeSetting).toBe(true));

		// A different setting value for the new room proves it actually refetched rather
		// than just keeping the first room's cached settings around.
		respondWithSelectionsAndNotifications([], { notifyMaybe: false });
		await room.bootstrap('tmr26-def456');

		await vi.waitFor(() => expect(room.notifyMaybeSetting).toBe(false));
		room.dispose();
	});

	it('prompts for reauth when the settings fetch is rejected as unauthorized', async () => {
		signIn();
		fetchMock.mockImplementation((url: string, init?: RequestInit) => {
			if (url.includes('/timetable.json')) return Promise.resolve(timetableResponseFor(url));
			if (url.includes('/users/me/notifications')) return Promise.resolve(jsonResponse({}, 401));
			if (!init) return Promise.resolve(jsonResponse([]));
			return Promise.resolve(jsonResponse({ ok: true }));
		});
		const room = createRoom();

		await room.bootstrap(ROOM_ID);

		await vi.waitFor(() => expect(room.reauthRequired).toBe(true));
		room.dispose();
	});

	it('retries automatically after a non-auth load failure at bootstrap', async () => {
		signIn();
		let calls = 0;
		fetchMock.mockImplementation((url: string, init?: RequestInit) => {
			if (url.includes('/timetable.json')) return Promise.resolve(timetableResponseFor(url));
			if (url.includes('/users/me/notifications')) {
				calls++;
				return Promise.resolve(calls === 1 ? jsonResponse({}, 500) : jsonResponse({
					leadMinutes: 15,
					notifyMaybe: false,
					notifyOverrides: {},
					enabled: true,
					subscribedHere: false
				}));
			}
			if (!init) return Promise.resolve(jsonResponse([]));
			return Promise.resolve(jsonResponse({ ok: true }));
		});
		const room = createRoom();

		await room.bootstrap(ROOM_ID);
		await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(1));
		expect(room.notificationSettings).toBeNull(); // the failed first attempt left nothing cached

		// Retries are only possible once the failed request's cleanup (resetting the
		// "already requested" guard) has actually run, so retry the call itself inside
		// the wait rather than racing a fixed number of ticks against that cleanup.
		await vi.waitFor(() => {
			room.setViewMode('picks');
			expect(calls).toBeGreaterThanOrEqual(2);
		});
		await vi.waitFor(() => expect(room.notificationSettings).not.toBeNull());
		room.dispose();
	});

	describe('notifyStateOf', () => {
		async function markedRoom(settings: Partial<NotificationSettings> = {}) {
			signIn();
			respondWithSelectionsAndNotifications([], settings);
			const room = createRoom();
			await room.bootstrap(ROOM_ID);
			room.confirmJoin();
			room.togglePerformance(PERF_ID); // going
			room.setViewMode('picks');
			await vi.waitFor(() => expect(room.notificationSettings).not.toBeNull());
			return room;
		}

		it('is false for an unmarked performance', async () => {
			const room = await markedRoom();
			expect(room.notifyStateOf('not-marked')).toBe(false);
			room.dispose();
		});

		it('going notifies by default, regardless of notifyMaybe', async () => {
			const room = await markedRoom({ notifyMaybe: false });
			expect(room.notifyStateOf(PERF_ID)).toBe(true);
			room.dispose();
		});

		it('maybe notifies only when notifyMaybe is on', async () => {
			const room = await markedRoom({ notifyMaybe: false });
			room.togglePerformance(PERF_ID); // maybe
			expect(room.notifyStateOf(PERF_ID)).toBe(false);
			room.dispose();
		});

		it('an override replaces the default', async () => {
			const room = await markedRoom({ notifyMaybe: false, notifyOverrides: { [PERF_ID]: false } });
			expect(room.notifyStateOf(PERF_ID)).toBe(false);
			room.dispose();
		});
	});

	describe('toggleNotifyOverride', () => {
		it('flips the effective state and writes an explicit override', async () => {
			signIn();
			respondWithSelectionsAndNotifications([], { notifyMaybe: false });
			const room = createRoom();
			await room.bootstrap(ROOM_ID);
			room.confirmJoin();
			room.togglePerformance(PERF_ID); // going — notifies by default
			room.setViewMode('picks');
			await vi.waitFor(() => expect(room.notificationSettings).not.toBeNull());
			fetchMock.mockClear();

			room.toggleNotifyOverride(PERF_ID);

			expect(room.notifyStateOf(PERF_ID)).toBe(false);
			await vi.waitFor(() => {
				const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
				expect(put).toBeDefined();
				expect(JSON.parse(put![1].body)).toMatchObject({ notifyOverrides: { [PERF_ID]: false } });
			});
			room.dispose();
		});

		it('sends null (removing the key) when toggling back to the default', async () => {
			signIn();
			respondWithSelectionsAndNotifications([], {
				notifyMaybe: false,
				notifyOverrides: { [PERF_ID]: false }
			});
			const room = createRoom();
			await room.bootstrap(ROOM_ID);
			room.confirmJoin();
			room.togglePerformance(PERF_ID); // going
			room.setViewMode('picks');
			await vi.waitFor(() => expect(room.notificationSettings).not.toBeNull());
			expect(room.notifyStateOf(PERF_ID)).toBe(false); // overridden off
			fetchMock.mockClear();

			room.toggleNotifyOverride(PERF_ID); // back to true — the default for "going"

			expect(room.notifyStateOf(PERF_ID)).toBe(true);
			await vi.waitFor(() => {
				const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
				expect(put).toBeDefined();
				expect(JSON.parse(put![1].body)).toMatchObject({ notifyOverrides: { [PERF_ID]: null } });
			});
			room.dispose();
		});

		it('does nothing when push is off for the account', async () => {
			signIn();
			respondWithSelectionsAndNotifications([], { enabled: false });
			const room = createRoom();
			await room.bootstrap(ROOM_ID);
			room.confirmJoin();
			room.togglePerformance(PERF_ID);
			room.setViewMode('picks');
			await vi.waitFor(() => expect(room.notificationSettings).not.toBeNull());
			fetchMock.mockClear();

			room.toggleNotifyOverride(PERF_ID);
			await Promise.resolve();

			expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
			room.dispose();
		});

		it('does nothing for a performance that is not marked', async () => {
			signIn();
			respondWithSelectionsAndNotifications([], { notifyMaybe: true });
			const room = createRoom();
			await room.bootstrap(ROOM_ID);
			room.confirmJoin();
			room.setViewMode('picks');
			await vi.waitFor(() => expect(room.notificationSettings).not.toBeNull());
			fetchMock.mockClear();

			room.toggleNotifyOverride('not-marked');
			await Promise.resolve();

			expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
			room.dispose();
		});

		it('reverts the optimistic change and surfaces an error when the write fails', async () => {
			signIn();
			respondWithSelectionsAndNotifications([], { notifyMaybe: false }, () => jsonResponse({}, 500));
			const room = createRoom();
			await room.bootstrap(ROOM_ID);
			room.confirmJoin();
			room.togglePerformance(PERF_ID); // going
			room.setViewMode('picks');
			await vi.waitFor(() => expect(room.notificationSettings).not.toBeNull());

			room.toggleNotifyOverride(PERF_ID);
			expect(room.notifyStateOf(PERF_ID)).toBe(false); // optimistic flip

			await vi.waitFor(() => expect(room.notifyStateOf(PERF_ID)).toBe(true));
			expect(room.writeError).toMatch(/notifications/i);
			room.dispose();
		});

		it('prompts for reauth when a bell write is rejected as unauthorized', async () => {
			signIn();
			respondWithSelectionsAndNotifications([], { notifyMaybe: false }, () => jsonResponse({}, 401));
			const room = createRoom();
			await room.bootstrap(ROOM_ID);
			room.confirmJoin();
			room.togglePerformance(PERF_ID); // going
			room.setViewMode('picks');
			await vi.waitFor(() => expect(room.notificationSettings).not.toBeNull());

			room.toggleNotifyOverride(PERF_ID);

			await vi.waitFor(() => expect(room.reauthRequired).toBe(true));
			expect(room.notifyStateOf(PERF_ID)).toBe(true); // reverted
			room.dispose();
		});

		it('surfaces an error, without a crash, when the session is gone at write time', async () => {
			signIn();
			respondWithSelectionsAndNotifications([], { notifyMaybe: false });
			const room = createRoom();
			await room.bootstrap(ROOM_ID);
			room.confirmJoin();
			// confirmJoin fires its own (unrelated) picks write; let it settle so its later
			// success doesn't clobber the notify-write's error we're about to assert on.
			await vi.waitFor(() =>
				expect(
					fetchMock.mock.calls.some(
						([url, init]) =>
							String(url).includes(`/rooms/${ROOM_ID}/selections`) &&
							(init as RequestInit | undefined)?.method === 'PUT'
					)
				).toBe(true)
			);
			room.togglePerformance(PERF_ID); // going
			room.setViewMode('picks');
			await vi.waitFor(() => expect(room.notificationSettings).not.toBeNull());
			session.user = null; // session cleared between load and tap

			room.toggleNotifyOverride(PERF_ID);
			await vi.waitFor(() => expect(room.notifyStateOf(PERF_ID)).toBe(true)); // reverted
			expect(room.writeError).not.toBe('');
			room.dispose();
		});

		it('a stale response from an earlier toggle does not clobber a later one', async () => {
			signIn();
			const releases: Array<() => void> = [];
			fetchMock.mockImplementation((url: string, init?: RequestInit) => {
				if (url.includes('/timetable.json')) return Promise.resolve(timetableResponseFor(url));
				if (url.includes('/users/me/notifications')) {
					if (init?.method === 'PUT') {
						return new Promise((resolve) => releases.push(() => resolve(jsonResponse({ ok: true }))));
					}
					return Promise.resolve(
						jsonResponse({ leadMinutes: 15, notifyMaybe: false, notifyOverrides: {}, enabled: true, subscribedHere: false })
					);
				}
				if (!init) return Promise.resolve(jsonResponse([]));
				return Promise.resolve(jsonResponse({ ok: true }));
			});
			const room = createRoom();
			await room.bootstrap(ROOM_ID);
			room.confirmJoin();
			room.togglePerformance(PERF_ID); // going — notifies by default
			room.setViewMode('picks');
			await vi.waitFor(() => expect(room.notificationSettings).not.toBeNull());

			room.toggleNotifyOverride(PERF_ID); // -> false (override), PUT #1 in flight
			expect(room.notifyStateOf(PERF_ID)).toBe(false);
			room.toggleNotifyOverride(PERF_ID); // -> true (back to default, override cleared), PUT #2 in flight
			expect(room.notifyStateOf(PERF_ID)).toBe(true);

			// Resolve out of order: the newer request (#2) lands first, then the stale one (#1).
			releases[1]?.();
			await vi.waitFor(() => expect(room.writeError).toBe(''));
			releases[0]?.();
			await Promise.resolve();

			// The stale PUT #1 response must not revert the state #2 already established.
			expect(room.notifyStateOf(PERF_ID)).toBe(true);
			room.dispose();
		});
	});

	describe('setNotificationSettings', () => {
		it('merges onto the existing cache instead of replacing it', async () => {
			signIn();
			respondWithSelectionsAndNotifications([], {
				notifyMaybe: false,
				notifyOverrides: { [PERF_ID]: true },
				enabled: true
			});
			const room = createRoom();
			await room.bootstrap(ROOM_ID);
			room.setViewMode('picks');
			await vi.waitFor(() => expect(room.notificationSettings).not.toBeNull());

			room.setNotificationSettings({ leadMinutes: 30, notifyMaybe: true });

			expect(room.notificationSettings).toMatchObject({
				leadMinutes: 30,
				notifyMaybe: true,
				notifyOverrides: { [PERF_ID]: true },
				enabled: true
			});
			room.dispose();
		});

		it('falls back to sensible defaults when nothing was cached yet', async () => {
			const room = createRoom();

			room.setNotificationSettings({ enabled: true });

			expect(room.notificationSettings).toMatchObject({
				leadMinutes: 15,
				notifyMaybe: false,
				notifyOverrides: {},
				enabled: true
			});
			room.dispose();
		});
	});
});

describe('the timetable layout toggle', () => {
	it('flips between the grid and the list, remembering the choice', async () => {
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);

		expect(room.timetableLayout).toBe('grid');

		room.toggleTimetableLayout();
		expect(room.timetableLayout).toBe('list');
		expect(localStorage.getItem('stagehopper:view:timetableLayout')).toBe('list');

		room.toggleTimetableLayout();
		expect(room.timetableLayout).toBe('grid');
		expect(localStorage.getItem('stagehopper:view:timetableLayout')).toBe('grid');
		room.dispose();
	});

	// The preference is about the viewer, not the room: it is read at construction from a
	// single global key rather than reset per room the way room-scoped hints are.
	it('opens in the layout the viewer last chose', () => {
		localStorage.setItem('stagehopper:view:timetableLayout', 'list');

		const room = createRoom();

		expect(room.timetableLayout).toBe('list');
		room.dispose();
	});

	it('survives a switch to another room', async () => {
		signIn();
		respondWithSelections([]);
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.toggleTimetableLayout();

		await room.bootstrap('ps26-def456');

		expect(room.timetableLayout).toBe('list');
		room.dispose();
	});

	it('lists every day of the schedule, sorted by start time', async () => {
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);

		expect(room.scheduleGroups).toHaveLength(room.timetable.days.length);
		for (const group of room.scheduleGroups) {
			// Grid minutes, not clock time: a festival day runs past midnight, so 01:00 sorts
			// after 23:00 rather than before it.
			const starts = group.rows.map((row) => timeToGridMin(row.performance.startTime));
			expect([...starts].sort((a, b) => a - b)).toEqual(starts);
		}
		room.dispose();
	});
});

describe('the now-line', () => {
	it.each(['ps26-abc123', 'tmr26-abc123'])(
		'stays on the grid whenever the now-line is visible in %s',
		async (roomId) => {
			// The grid trims to a buffer around the day's own performances, so the
			// now-line only needs to be on-grid while it's actually shown.
			signIn();
			const room = createRoom();
			await room.bootstrap(roomId);

			for (let hour = 0; hour < 24; hour++) {
				vi.setSystemTime(new Date(2026, 6, 17, hour, 0));
				room.tickNow();

				if (!room.nowVisible) continue;
				expect(room.nowTopPx, `${hour}:00 in ${roomId}`).toBeGreaterThanOrEqual(0);
				expect(room.nowTopPx).toBeLessThan(room.gridHeightPx);
			}

			vi.useRealTimers();
			room.dispose();
		}
	);

	it('re-places the line when the grid moves under it', async () => {
		// Primavera's grid opens at 14:00 and Tomorrowland's at 09:30, so 10:00 sits at
		// opposite ends of the two grids.
		vi.setSystemTime(new Date(2026, 6, 17, 10, 0));
		signIn();
		const room = createRoom();

		await room.bootstrap('tmr26-abc123');
		room.tickNow();
		const tomorrowlandTop = room.nowTopPx;

		await room.bootstrap('ps26-abc123');
		const primaveraTop = room.nowTopPx;

		expect(tomorrowlandTop).toBeLessThan(primaveraTop);
		vi.useRealTimers();
		room.dispose();
	});

	it('hides the line until the first tick', async () => {
		const room = createRoom();
		await room.bootstrap('tmr26');

		expect(room.nowVisible).toBe(false);
		room.dispose();
	});

	it('shows the now-line only on the festival day in progress', async () => {
		// Noon on Tomorrowland's 2026-07-17 day.
		vi.setSystemTime(new Date(2026, 6, 17, 12, 0));
		signIn();
		const room = createRoom();
		await room.bootstrap('tmr26-abc123');
		room.tickNow();

		// Bootstraps onto today, where the line belongs.
		expect(room.todayDayIdx).toBeGreaterThanOrEqual(0);
		expect(room.currentDayIdx).toBe(room.todayDayIdx);
		expect(room.nowVisible).toBe(true);

		// Any other day hides it, even though the clock is unchanged.
		room.selectDay(room.todayDayIdx === 0 ? 1 : 0);
		expect(room.nowVisible).toBe(false);

		// Returning to today brings it back.
		room.selectDay(room.todayDayIdx);
		expect(room.nowVisible).toBe(true);

		vi.useRealTimers();
		room.dispose();
	});

	it('hides the now-line when the festival is not running today', async () => {
		vi.setSystemTime(new Date(2026, 0, 1, 12, 0)); // No festival day on Jan 1.
		signIn();
		const room = createRoom();
		await room.bootstrap('tmr26-abc123');
		room.tickNow();

		expect(room.todayDayIdx).toBe(-1);
		expect(room.nowVisible).toBe(false);

		vi.useRealTimers();
		room.dispose();
	});
});

describe('day navigation', () => {
	it('wraps forward past the last day and backwards past the first', async () => {
		const room = createRoom();
		await room.bootstrap('tmr26');
		const dayCount = room.timetable.days.length;
		room.selectDay(dayCount - 1);

		room.stepDay(1);
		expect(room.currentDayIdx).toBe(0);

		room.stepDay(-1);
		expect(room.currentDayIdx).toBe(dayCount - 1);
		room.dispose();
	});
});

describe('deep-link to a performance (#perf-{id})', () => {
	// A set on the third day of the tmr26 fixture; distinct from the initial day.
	const DAY3_PERF_ID = '3006779334';

	it('maps a performance id to the day that contains it', async () => {
		const room = createRoom();
		await room.bootstrap('tmr26');
		expect(room.dayIndexForPerformance(DAY3_PERF_ID)).toBe(2);
		expect(room.dayIndexForPerformance('nope-not-here')).toBe(-1);
		room.dispose();
	});

	it('focuses the set: switches to its day, timetable view, and marks it highlighted', async () => {
		const room = createRoom();
		await room.bootstrap('tmr26');
		room.viewMode = 'picks';
		room.currentDayIdx = 0;

		expect(room.focusPerformance(DAY3_PERF_ID)).toBe(true);
		expect(room.currentDayIdx).toBe(2);
		expect(room.viewMode).toBe('full');
		expect(room.highlightedPerfId).toBe(DAY3_PERF_ID);
		room.dispose();
	});

	it('leaves state untouched and returns false for an unknown id', async () => {
		const room = createRoom();
		await room.bootstrap('tmr26');
		room.currentDayIdx = 1;

		expect(room.focusPerformance('unknown-id')).toBe(false);
		expect(room.currentDayIdx).toBe(1);
		expect(room.highlightedPerfId).toBeNull();
		room.dispose();
	});
});

describe('joining', () => {
	it('records the chosen name and colour, and replays a deferred pick', async () => {
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.pendingGuestAction = { type: 'perf', performanceId: 'p1' };
		room.joinName = '  Alex  ';
		room.joinColor = '#2ecc71';

		room.confirmJoin();

		expect(room.myName).toBe('Alex');
		expect(room.myColor).toBe('#2ecc71');
		expect(room.joinModalOpen).toBe(false);
		expect(room.myState('p1')).toBe(1);
		expect(localStorage.getItem(`stagehopper:${ROOM_ID}:name`)).toBe('Alex');
		room.dispose();
	});

	it('refuses an empty name', async () => {
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.joinName = '   ';

		room.confirmJoin();

		expect(room.joinModalOpen).toBe(true);
		room.dispose();
	});

	it('will not hand out a colour another participant already claimed', async () => {
		signIn();
		respondWithSelections([{ userId: 'clerk:a', name: 'A', color: '#3498db', selections: {} }]);
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		const initialColor = room.joinColor;

		room.selectJoinColor('#3498db');

		expect(room.joinColor).toBe(initialColor);
		room.dispose();
	});
});

describe('polling', () => {
	it('re-reads the room on an interval, and skips it while the tab is hidden', async () => {
		vi.useFakeTimers();
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		fetchMock.mockClear();

		await vi.advanceTimersByTimeAsync(10_000);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		hidden.mockReturnValue(false);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fetchMock).toHaveBeenCalledTimes(2);

		room.dispose();
	});

	it('stops polling once disposed', async () => {
		vi.useFakeTimers();
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.dispose();
		fetchMock.mockClear();

		await vi.advanceTimersByTimeAsync(30_000);

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('surfaces a sync failure and keeps the local snapshot', async () => {
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.confirmJoin();
		room.togglePerformance('p1');

		fetchMock.mockResolvedValue(jsonResponse({}, 503));
		// Read errors are debounced; they surface after 2 consecutive failures
		await room.refresh();
		expect(room.syncError).toBe('');
		await room.refresh();

		expect(room.syncError).toMatch(/reach the server|retrying/i);
		expect(room.myState('p1')).toBe(1);
		room.dispose();
	});

	it('keeps a read failure visible even when a save succeeds afterwards', async () => {
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.confirmJoin();

		// Read errors are debounced; surface after 2 failures
		fetchMock.mockResolvedValueOnce(jsonResponse({}, 503));
		await room.refresh();
		expect(room.syncError).toBe('');
		fetchMock.mockResolvedValueOnce(jsonResponse({}, 503));
		await room.refresh();
		expect(room.syncError).toMatch(/reach the server|retrying/i);

		room.togglePerformance('p1');
		room.flushPendingWrites();
		await vi.waitFor(() => expect(room.writeError).toBe(''));

		// Read failure persists even after successful write
		expect(room.syncError).toMatch(/reach the server|retrying/i);
		room.dispose();
	});
});

describe('room display name', () => {
	it('picks up a custom name from the room row, without treating it as a participant', async () => {
		signIn();
		respondWithSelections([
			{ userId: VIEWER_ID, name: 'Alex', color: '#3498db', selections: { p1: 1 } },
			{ userId: '@room', displayName: 'Squad Goals' }
		]);
		const room = createRoom();

		await room.bootstrap(ROOM_ID);

		expect(room.roomDisplayName).toBe('Squad Goals');
		expect(room.allSelections.map((s) => s.userId)).toEqual([VIEWER_ID]);
		room.dispose();
	});

	it('leaves the name null for a room that was never given one', async () => {
		signIn();
		const room = createRoom();

		await room.bootstrap(ROOM_ID);

		expect(room.roomDisplayName).toBeNull();
		room.dispose();
	});
});

describe('sharing', () => {
	/** Swap in a share/clipboard capable navigator for the duration of one test. */
	function stubNavigator(overrides: { share?: unknown; writeText?: unknown }) {
		vi.stubGlobal('navigator', {
			...navigator,
			...(overrides.share ? { share: overrides.share } : {}),
			clipboard: { writeText: overrides.writeText ?? vi.fn().mockResolvedValue(undefined) }
		});
	}

	it('offers the native share sheet with the festival name', async () => {
		const share = vi.fn().mockResolvedValue(undefined);
		const writeText = vi.fn();
		stubNavigator({ share, writeText });
		const room = createRoom();
		await room.bootstrap('tmr26');

		await room.share();

		expect(share).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Tomorrowland 2026 – Week 1', url: expect.any(String) })
		);
		expect(writeText).not.toHaveBeenCalled();
		expect(room.copied).toBe(false);
		room.dispose();
	});

	it('describes a room invite differently from a lineup link', async () => {
		const share = vi.fn().mockResolvedValue(undefined);
		stubNavigator({ share });
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);

		await room.share();

		expect(share.mock.calls[0]?.[0].text).toMatch(/join my/i);
		room.dispose();
	});

	it('names the room in the share text and title when it has a custom name', async () => {
		const share = vi.fn().mockResolvedValue(undefined);
		stubNavigator({ share });
		signIn();
		respondWithSelections([{ userId: '@room', displayName: 'Squad Goals' }]);
		const room = createRoom();
		await room.bootstrap(ROOM_ID);

		await room.share();

		expect(share).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Squad Goals', text: 'Join Squad Goals on StageHopper' })
		);
		room.dispose();
	});

	it('stays quiet when the user dismisses the share sheet', async () => {
		const abort = Object.assign(new Error('dismissed'), { name: 'AbortError' });
		const writeText = vi.fn();
		stubNavigator({ share: vi.fn().mockRejectedValue(abort), writeText });
		const room = createRoom();
		await room.bootstrap('tmr26');

		await room.share();

		expect(writeText).not.toHaveBeenCalled();
		expect(room.copied).toBe(false);
		room.dispose();
	});

	it('treats a DOMException-style rejection as a dismissal too', async () => {
		// navigator.share rejects with a DOMException, which is not an Error subclass
		// in every engine — the check has to be structural.
		const writeText = vi.fn();
		stubNavigator({ share: vi.fn().mockRejectedValue({ name: 'AbortError' }), writeText });
		const room = createRoom();
		await room.bootstrap('tmr26');

		await room.share();

		expect(writeText).not.toHaveBeenCalled();
		room.dispose();
	});

	it('falls back to the clipboard when sharing fails for real', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		stubNavigator({ share: vi.fn().mockRejectedValue(new Error('not allowed')), writeText });
		const room = createRoom();
		await room.bootstrap('tmr26');

		await room.share();

		expect(writeText).toHaveBeenCalledWith(expect.stringContaining('http'));
		expect(room.copied).toBe(true);
		room.dispose();
	});

	it('copies straight to the clipboard where there is no share sheet', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		stubNavigator({ writeText });
		const room = createRoom();
		await room.bootstrap('tmr26');

		await room.share();

		expect(writeText).toHaveBeenCalledOnce();
		expect(room.copied).toBe(true);
		room.dispose();
	});

	it('clears the copied confirmation after a moment', async () => {
		vi.useFakeTimers();
		stubNavigator({ writeText: vi.fn().mockResolvedValue(undefined) });
		const room = createRoom();
		await room.bootstrap('tmr26');
		await room.share();
		expect(room.copied).toBe(true);

		await vi.advanceTimersByTimeAsync(2500);

		expect(room.copied).toBe(false);
		room.dispose();
	});

	it('says nothing when the clipboard is blocked', async () => {
		stubNavigator({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
		const room = createRoom();
		await room.bootstrap('tmr26');

		await room.share();

		expect(room.copied).toBe(false);
		room.dispose();
	});
});

describe('leaving a room', () => {
	it('navigates home after the backend confirms', async () => {
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);

		await room.confirmLeaveRoom();

		expect(navigate).toHaveBeenCalledWith('/');
		expect(room.leaveDialogOpen).toBe(false);
		room.dispose();
	});

	it('keeps the dialog open and explains a failure', async () => {
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.openLeaveDialog();
		fetchMock.mockResolvedValue(jsonResponse({}, 500));

		await room.confirmLeaveRoom();

		expect(room.leaveDialogOpen).toBe(true);
		expect(room.leaveError).toMatch(/could not leave/i);
		expect(navigate).not.toHaveBeenCalledWith('/');
		room.dispose();
	});
});

describe('favourite stages', () => {
	it('floats a favourited stage to the front of the order and persists it', async () => {
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		expect(room.stageOrder[0]).not.toBe('CRYSTAL GARDEN');

		room.toggleFavouriteStage('CRYSTAL GARDEN');

		expect(room.isFavouriteStage('CRYSTAL GARDEN')).toBe(true);
		expect(room.stageOrder[0]).toBe('CRYSTAL GARDEN');
		expect(loadFavouriteStages(ROOM_ID).has('CRYSTAL GARDEN')).toBe(true);
		room.dispose();
	});

	it('keeps favourites in their original relative order', async () => {
		const room = createRoom();
		await room.bootstrap(ROOM_ID);

		// Favourite in reverse of their timetable order; they should still lead in order.
		room.toggleFavouriteStage('CRYSTAL GARDEN');
		room.toggleFavouriteStage('MAINSTAGE');

		expect(room.stageOrder.slice(0, 2)).toEqual(['MAINSTAGE', 'CRYSTAL GARDEN']);
		room.dispose();
	});

	it('drops a stage back when unfavourited', async () => {
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.toggleFavouriteStage('CRYSTAL GARDEN');

		room.toggleFavouriteStage('CRYSTAL GARDEN');

		expect(room.isFavouriteStage('CRYSTAL GARDEN')).toBe(false);
		expect(room.stageOrder[0]).toBe('MAINSTAGE');
		room.dispose();
	});
});

describe('opening details by id', () => {
	it('resolves the full performance by id and opens its card', async () => {
		const room = createRoom();
		await room.bootstrap(ROOM_ID);

		room.openDetailsById('3006621839');

		expect(room.detailsPerformance?.id).toBe('3006621839');
		room.dispose();
	});

	it('does nothing for an unknown id', async () => {
		const room = createRoom();
		await room.bootstrap(ROOM_ID);

		room.openDetailsById('nope');

		expect(room.detailsPerformance).toBeNull();
		room.dispose();
	});
});

describe('map overlay', () => {
	it('sets mapOpen true and pushes history on openMap', async () => {
		const room = createRoom();
		await room.bootstrap(ROOM_ID);

		room.openMap();

		expect(room.mapOpen).toBe(true);
		room.dispose();
	});

	it('closes the map when closeMap is called and no history entry exists', async () => {
		vi.stubGlobal('history', {
			pushState: () => {},
			back: () => {},
			state: null
		});
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.mapOpen = true;

		room.closeMap();

		expect(room.mapOpen).toBe(false);
		vi.unstubAllGlobals();
		room.dispose();
	});

	it('clears mapOpen on handlePopState', async () => {
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.mapOpen = true;

		room.handlePopState();

		expect(room.mapOpen).toBe(false);
		room.dispose();
	});

	it('clears detailsPerformance on handlePopState', async () => {
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.detailsPerformance = { id: 'p1', artist: 'Test', stage: 'Main', startTime: '10:00', endTime: '11:00' };

		room.handlePopState();

		expect(room.detailsPerformance).toBeNull();
		room.dispose();
	});
});

describe('offline resilience snapshots', () => {
	it('hydrates others picks from snapshot when initial refresh fails', async () => {
		signIn();
		const cachedOthers = [
			{ userId: 'clerk:456', name: 'Bob', color: '#3498db', selections: { p1: 2, p2: 1 } },
			{ userId: 'clerk:789', name: 'Charlie', color: '#2ecc71', selections: { p1: 1 } }
		];
		localStorage.setItem(`stagehopper:${ROOM_ID}:allSnapshot`, JSON.stringify(cachedOthers));
		fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url.includes('/timetable.json')) return timetableResponseFor(url);
			if (!init && url.includes(ROOM_ID)) {
				// Simulate network failure
				throw new Error('Network error');
			}
			return jsonResponse({ ok: true });
		});
		const room = createRoom();

		await room.bootstrap(ROOM_ID);

		expect(room.allSelections).toHaveLength(3); // viewer + 2 others from snapshot
		const bob = room.allSelections.find((s) => s.userId === 'clerk:456');
		expect(bob?.selections).toEqual({ p1: 2, p2: 1 });
		room.dispose();
	});

	it('keeps an existing member out of the join modal when the read fails, so their unsynced picks survive', async () => {
		signIn();
		// This browser is already a participant here, and has picks it never managed to sync.
		const cachedAll = [
			{ userId: VIEWER_ID, name: 'Alex', color: '#e74c3c', selections: { p1: 1 } },
			{ userId: 'clerk:456', name: 'Bob', color: '#3498db', selections: { p2: 2 } }
		];
		localStorage.setItem(`stagehopper:${ROOM_ID}:allSnapshot`, JSON.stringify(cachedAll));
		localStorage.setItem(
			`stagehopper:${ROOM_ID}:mySnapshot`,
			JSON.stringify({ selections: { p1: 1 }, pendingWrite: true })
		);
		fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url.includes('/timetable.json')) return timetableResponseFor(url);
			if (!init && url.includes(ROOM_ID)) throw new Error('Network error');
			return jsonResponse({ ok: true });
		});
		const room = createRoom();

		await room.bootstrap(ROOM_ID);

		expect(room.joinModalOpen).toBe(false);
		expect(room.mySelections).toEqual({ p1: 1 });
		room.dispose();
	});

	it('restores pending write from snapshot and retries on polling', async () => {
		vi.useFakeTimers();
		signIn();
		localStorage.setItem(`stagehopper:${ROOM_ID}:mySnapshot`, JSON.stringify({ selections: { p1: 1, p2: 2 }, pendingWrite: true }));
		fetchMock.mockImplementation((url: string, init?: RequestInit) => {
			if (url.includes('/timetable.json')) return timetableResponseFor(url);
			if (!init) return Promise.resolve(jsonResponse([
				{ userId: VIEWER_ID, name: 'Alex', color: '#e74c3c', selections: {} }
			]));
			// First PUT fails (network issue)
			if (fetchMock.mock.calls.length === 1) {
				return Promise.resolve(jsonResponse({}, 500));
			}
			return Promise.resolve(jsonResponse({ ok: true }));
		});
		const room = createRoom();

		await room.bootstrap(ROOM_ID);

		expect(room.mySelections).toEqual({ p1: 1, p2: 2 });
		room.startPolling();
		await vi.advanceTimersByTimeAsync(10_000); // One poll interval

		// Should have retried the write on the polling tick
		const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
		expect(puts.length).toBeGreaterThan(0);
		room.dispose();
	});

	it('does not use stale local snapshot on successful online load', async () => {
		signIn();
		// Stale snapshot from a previous session with old picks
		localStorage.setItem(`stagehopper:${ROOM_ID}:mySnapshot`, JSON.stringify({ selections: { p_old: 2 }, pendingWrite: false }));
		respondWithSelections([
			{ userId: VIEWER_ID, name: 'Alex', color: '#e74c3c', selections: { p_new: 1 } }
		]);
		const room = createRoom();

		await room.bootstrap(ROOM_ID);

		// Should have loaded the fresh remote picks, not the stale local ones.
		expect(room.mySelections).toEqual({ p_new: 1 });
		expect(room.mySelections).not.toHaveProperty('p_old');
		room.dispose();
	});

	it('clears room snapshots when leaving a room', async () => {
		signIn();
		localStorage.setItem(`stagehopper:${ROOM_ID}:mySnapshot`, JSON.stringify({ selections: { p1: 1 }, pendingWrite: false }));
		localStorage.setItem(`stagehopper:${ROOM_ID}:allSnapshot`, JSON.stringify([]));
		const room = createRoom();

		await room.bootstrap(ROOM_ID);
		await room.confirmLeaveRoom();

		expect(localStorage.getItem(`stagehopper:${ROOM_ID}:mySnapshot`)).toBeNull();
		expect(localStorage.getItem(`stagehopper:${ROOM_ID}:allSnapshot`)).toBeNull();
		room.dispose();
	});

	it('clears all snapshots when signing out', async () => {
		signIn();
		localStorage.setItem(`stagehopper:${ROOM_ID}:mySnapshot`, JSON.stringify({ selections: { p1: 1 }, pendingWrite: false }));
		localStorage.setItem(`stagehopper:tmr26-other:allSnapshot`, JSON.stringify([]));
		const room = createRoom();

		await room.bootstrap(ROOM_ID);
		room.signOut();

		expect(localStorage.getItem(`stagehopper:${ROOM_ID}:mySnapshot`)).toBeNull();
		expect(localStorage.getItem(`stagehopper:tmr26-other:allSnapshot`)).toBeNull();
		room.dispose();
	});
});
