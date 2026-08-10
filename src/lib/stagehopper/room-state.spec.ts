import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomState } from './room-state.svelte.js';
import { loadFavouriteStages, saveGoogleAuth } from './storage.js';
import type { RoomSelection } from './types.js';
import tmr26Timetable from '../../test-support/fixtures/timetable-tmr26.json';
import ps26Timetable from '../../test-support/fixtures/timetable-ps26.json';

const ROOM_ID = 'tmr26-abc123';
const VIEWER_ID = 'google:123';

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
	if (url.includes('timetable-tmr26')) return jsonResponse(tmr26Timetable);
	if (url.includes('timetable-ps26')) return jsonResponse(ps26Timetable);
	return jsonResponse({ formatVersion: 1, festivalId: 'unknown', days: [] }, 404);
}

/** Reply to a GET of the room's selections; every other call succeeds emptily. */
function respondWithSelections(selections: RoomSelection[]) {
	fetchMock.mockImplementation((url: string, init?: RequestInit) => {
		if (typeof url === 'string' && url.startsWith('/data/timetable-')) {
			return Promise.resolve(timetableResponseFor(url));
		}
		if (!init) return Promise.resolve(jsonResponse(selections));
		return Promise.resolve(jsonResponse({ ok: true }));
	});
}

function signIn() {
	saveGoogleAuth({ idToken: 'tok', sub: '123', name: 'Alex Example', givenName: 'Alex' });
}

function createRoom() {
	return new RoomState({ navigate });
}

beforeEach(() => {
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
			if (url.startsWith('/data/timetable-')) return timetableResponseFor(url);
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

	it('prompts for re-authentication when the saved token has expired', async () => {
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.confirmJoin();

		fetchMock.mockResolvedValue(jsonResponse({ error: 'Invalid Google token' }, 401));
		room.togglePerformance('p1');
		room.flushPendingWrites();
		await vi.waitFor(() => expect(room.reauthRequired).toBe(true));

		expect(room.syncError).toMatch(/signed out of google/i);
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
		room.requestGuestAction('like', 'p1');

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

/** A decodable (unsigned) token; only the client-side decode path reads it. */
function fakeIdToken(sub: string, name = 'Alex Example'): string {
	const payload = btoa(JSON.stringify({ sub, name, given_name: 'Alex' }))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
	return `header.${payload}.signature`;
}

describe('guest sign-in credentials', () => {
	it('adopts the identity and replays the action the guest was blocked on', async () => {
		const room = createRoom();
		await room.bootstrap('tmr26');
		room.requestGuestAction('perf', 'p1');

		room.handleGuestCredential({ credential: fakeIdToken('999') });

		expect(room.userId).toBe('google:999');
		expect(room.hasGlobalAuth).toBe(true);
		expect(room.guestSigninOpen).toBe(false);
		expect(room.googleAuthError).toBe('');
		expect(localStorage.getItem('stagehopper:auth:sub')).toBe('999');
		await vi.waitFor(() =>
			expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/room\/tmr26-/))
		);
		room.dispose();
	});

	it('signs the guest in without starting a room when nothing was pending', async () => {
		const room = createRoom();
		await room.bootstrap('tmr26');
		room.openGuestSignin();

		room.handleGuestCredential({ credential: fakeIdToken('999') });

		expect(room.hasGlobalAuth).toBe(true);
		expect(navigate).not.toHaveBeenCalled();
		room.dispose();
	});

	it('rejects a credential it cannot decode, keeping the modal up', async () => {
		const room = createRoom();
		await room.bootstrap('tmr26');
		room.requestGuestAction('perf', 'p1');

		room.handleGuestCredential({ credential: 'not-a-token' });

		expect(room.googleAuthError).toMatch(/sign-in failed/i);
		expect(room.userId).toBe('');
		expect(localStorage.getItem('stagehopper:auth:sub')).toBeNull();
		expect(navigate).not.toHaveBeenCalled();
		room.dispose();
	});

	it('rejects a response carrying no credential at all', async () => {
		const room = createRoom();
		await room.bootstrap('tmr26');

		room.handleGuestCredential({});

		expect(room.googleAuthError).toMatch(/sign-in failed/i);
		expect(room.hasGlobalAuth).toBe(false);
		room.dispose();
	});

	it('forgets a pending action when the guest backs out', async () => {
		const room = createRoom();
		await room.bootstrap('tmr26');
		room.requestGuestAction('like', 'p1');

		room.cancelGuestSignin();

		expect(room.guestSigninOpen).toBe(false);
		expect(room.pendingGuestAction).toBeNull();
		room.dispose();
	});
});

describe('re-authentication credentials', () => {
	/** A room whose token the backend has just rejected. */
	async function expiredRoom() {
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.confirmJoin();
		await vi.waitFor(() => expect(room.myName).toBeTruthy());

		fetchMock.mockResolvedValue(jsonResponse({ error: 'Invalid Google token' }, 401));
		room.togglePerformance('p1');
		room.flushPendingWrites();
		await vi.waitFor(() => expect(room.reauthRequired).toBe(true));
		return room;
	}

	it('refuses a different Google account and stays locked', async () => {
		const room = await expiredRoom();
		const originalToken = room.googleIdToken;

		room.handleReauthCredential({ credential: fakeIdToken('someone-else') });

		expect(room.googleAuthError).toMatch(/same google account/i);
		expect(room.reauthRequired).toBe(true);
		expect(room.googleIdToken).toBe(originalToken);
		expect(localStorage.getItem('stagehopper:auth:sub')).toBe('123');
		room.dispose();
	});

	it('refuses a credential it cannot decode', async () => {
		const room = await expiredRoom();

		room.handleReauthCredential({ credential: 'not-a-token' });

		expect(room.googleAuthError).toMatch(/same google account/i);
		expect(room.reauthRequired).toBe(true);
		room.dispose();
	});

	it('accepts the same account, stores the fresh token and retries the save', async () => {
		const room = await expiredRoom();
		const refreshedToken = fakeIdToken('123');
		respondWithSelections([]);
		fetchMock.mockClear();

		room.handleReauthCredential({ credential: refreshedToken });

		expect(room.reauthRequired).toBe(false);
		expect(room.googleAuthError).toBe('');
		expect(room.googleIdToken).toBe(refreshedToken);
		expect(localStorage.getItem('stagehopper:auth:idToken')).toBe(refreshedToken);

		await vi.waitFor(() => {
			const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
			expect(writes).toHaveLength(1);
			expect(JSON.parse(writes[0]?.[1].body).googleIdToken).toBe(refreshedToken);
		});
		expect(room.syncError).toBe('');
		room.dispose();
	});

	it('keeps the picks made before the session expired', async () => {
		const room = await expiredRoom();
		respondWithSelections([]);

		room.handleReauthCredential({ credential: fakeIdToken('123') });

		expect(room.myState('p1')).toBe(1);
		room.dispose();
	});
});

describe('liked performances', () => {
	it('toggles a like and persists it per room', async () => {
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);

		room.toggleLiked('p1');
		expect(room.isLiked('p1')).toBe(true);
		expect(localStorage.getItem(`stagehopper:${ROOM_ID}:liked`)).toBe('["p1"]');

		room.toggleLiked('p1');
		expect(room.isLiked('p1')).toBe(false);
		room.dispose();
	});

	it('restores likes when the room is reopened', async () => {
		signIn();
		localStorage.setItem(`stagehopper:${ROOM_ID}:liked`, '["p1"]');
		const room = createRoom();

		await room.bootstrap(ROOM_ID);

		expect(room.isLiked('p1')).toBe(true);
		room.dispose();
	});
});

describe('participant filtering', () => {
	const friendA = { userId: 'google:a', name: 'A', color: '#3498db', selections: {} };
	const friendB = { userId: 'google:b', name: 'B', color: '#2ecc71', selections: {} };

	async function roomWithFriends() {
		signIn();
		respondWithSelections([
			{ userId: VIEWER_ID, name: 'Alex', color: '#e74c3c', selections: {} },
			friendA,
			friendB
		]);
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		return room;
	}

	it('shows everyone by default', async () => {
		const room = await roomWithFriends();

		expect(room.showingAllParticipants).toBe(true);
		expect(room.filteredSelections).toHaveLength(3);
		room.dispose();
	});

	it('hides a de-selected participant while always keeping the viewer', async () => {
		const room = await roomWithFriends();

		room.toggleParticipantFilter(friendA.userId);

		expect(room.filteredSelections.map((s) => s.userId)).toEqual([friendB.userId, VIEWER_ID]);
		room.dispose();
	});

	it('ignores an attempt to filter out the viewer', async () => {
		const room = await roomWithFriends();

		room.toggleParticipantFilter(VIEWER_ID);

		expect(room.showingAllParticipants).toBe(true);
		room.dispose();
	});

	it('collapses back to show-everyone once each participant is re-selected', async () => {
		const room = await roomWithFriends();

		room.toggleParticipantFilter(friendA.userId);
		room.toggleParticipantFilter(friendA.userId);

		expect(room.showingAllParticipants).toBe(true);
		room.dispose();
	});

	it('drops a stored filter entry for a participant who has left', async () => {
		signIn();
		localStorage.setItem(
			`stagehopper:${ROOM_ID}:selectedOtherUserIds`,
			JSON.stringify([friendA.userId, 'google:gone'])
		);
		respondWithSelections([
			{ userId: VIEWER_ID, name: 'Alex', color: '#e74c3c', selections: {} },
			friendA,
			friendB
		]);
		const room = createRoom();

		await room.bootstrap(ROOM_ID);

		expect(room.selectedOtherUserIds).toEqual([friendA.userId]);
		room.dispose();
	});
});

describe('picks-only filter (the corner eye)', () => {
	it('explains an empty picks view differently before and after any pick', async () => {
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.confirmJoin();

		room.togglePicksOnly();
		expect(room.picksOnly).toBe(true);
		expect(room.statusMessage).toMatch(/after you mark performances/i);

		room.togglePerformance('no-such-performance');
		expect(room.statusMessage).toMatch(/no picks yet/i);
		room.dispose();
	});

	it('says nothing while the full timetable is showing', async () => {
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);

		expect(room.picksOnly).toBe(false);
		expect(room.statusMessage).toBe('');
		room.dispose();
	});

	it('toggles the filter off again', async () => {
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);

		room.togglePicksOnly();
		room.togglePicksOnly();

		expect(room.picksOnly).toBe(false);
		room.dispose();
	});
});

describe('the now-line', () => {
	it.each(['ps26-abc123', 'tmr26-abc123'])(
		'stays on the grid at every hour of the day in %s',
		async (roomId) => {
			signIn();
			const room = createRoom();
			await room.bootstrap(roomId);

			for (let hour = 0; hour < 24; hour++) {
				vi.setSystemTime(new Date(2026, 6, 17, hour, 0));
				room.tickNow();

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

describe('joining', () => {
	it('records the chosen name and colour, and replays a deferred like', async () => {
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.pendingGuestAction = { type: 'like', performanceId: 'p1' };
		room.joinName = '  Alex  ';
		room.joinColor = '#2ecc71';

		room.confirmJoin();

		expect(room.myName).toBe('Alex');
		expect(room.myColor).toBe('#2ecc71');
		expect(room.joinModalOpen).toBe(false);
		expect(room.isLiked('p1')).toBe(true);
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
		respondWithSelections([{ userId: 'google:a', name: 'A', color: '#3498db', selections: {} }]);
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
		await room.refresh();

		expect(room.syncError).toMatch(/sync failed/i);
		expect(room.myState('p1')).toBe(1);
		room.dispose();
	});

	it('keeps a read failure visible even when a save succeeds afterwards', async () => {
		signIn();
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.confirmJoin();

		fetchMock.mockResolvedValueOnce(jsonResponse({}, 503));
		await room.refresh();
		expect(room.syncError).toMatch(/sync failed/i);

		room.togglePerformance('p1');
		room.flushPendingWrites();
		await vi.waitFor(() => expect(room.writeError).toBe(''));

		expect(room.syncError).toMatch(/sync failed/i);
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
		expect(room.stageOrder[0]).not.toBe('MAINSTAGE');

		room.toggleFavouriteStage('MAINSTAGE');

		expect(room.isFavouriteStage('MAINSTAGE')).toBe(true);
		expect(room.stageOrder[0]).toBe('MAINSTAGE');
		expect(loadFavouriteStages(ROOM_ID).has('MAINSTAGE')).toBe(true);
		room.dispose();
	});

	it('keeps favourites in their original relative order', async () => {
		const room = createRoom();
		await room.bootstrap(ROOM_ID);

		// Favourite in reverse of their timetable order; they should still lead in order.
		room.toggleFavouriteStage('MAINSTAGE');
		room.toggleFavouriteStage('THE GATHERING');

		expect(room.stageOrder.slice(0, 2)).toEqual(['THE GATHERING', 'MAINSTAGE']);
		room.dispose();
	});

	it('drops a stage back when unfavourited', async () => {
		const room = createRoom();
		await room.bootstrap(ROOM_ID);
		room.toggleFavouriteStage('MAINSTAGE');

		room.toggleFavouriteStage('MAINSTAGE');

		expect(room.isFavouriteStage('MAINSTAGE')).toBe(false);
		expect(room.stageOrder[0]).toBe('THE GATHERING');
		room.dispose();
	});
});

describe('opening details from the liked list', () => {
	it('resolves the full performance by id and opens its card', async () => {
		const room = createRoom();
		await room.bootstrap(ROOM_ID);

		room.openDetailsById('3045510920');

		expect(room.detailsPerformance?.id).toBe('3045510920');
		expect(room.detailsStageName).toBe(room.detailsPerformance?.stage);
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
