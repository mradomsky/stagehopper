import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Clerk reduced to who is signed in; `api.ts` mints a token exactly when a user exists. */
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

const maybeOpenInstallPromo = vi.hoisted(() => vi.fn());
vi.mock('./install.js', () => ({ maybeOpenInstallPromo }));

import { FestivalSpace } from './festival-space.svelte.js';
import tmr26Timetable from '../../test-support/fixtures/timetable-tmr26.json';

const FESTIVAL = 'tmr26';
const PERF_A = '3006621839';
const PERF_B = '3006649694';
const PERF_C = '2934338506';
const COLOUR = '#e74c3c';
const OTHER_COLOUR = '#3498db';

const day0 = tmr26Timetable.days[0]!.performances;
/** A set that starts after A on the same day, to check time order. */
const LATE_PERF = day0[day0.length - 1]!.id;

type Row = { handle: string; colour: string; state: number };

/** Scripted backend: what each route answers, and what the client sent. */
const server = {
	publicPicks: {} as Record<string, Row[]>,
	publicStatus: 200,
	mine: {} as Record<string, number>,
	mineGate: null as Promise<void> | null,
	putGate: null as Promise<void> | null,
	timetableGate: null as Promise<void> | null,
	profilePutReply: null as null | { status: number; body: unknown },
	profile: { handle: 'alex', colour: COLOUR as string | null },
	putPicks: [] as Array<Record<string, number>>,
	putPicksImpl: null as null | (() => { status: number; body: unknown }),
	putColours: [] as string[],
	mineReads: 0,
	publicReads: 0
};

function resetServer() {
	server.publicPicks = {};
	server.publicStatus = 200;
	server.mine = {};
	server.mineGate = null;
	server.putGate = null;
	server.timetableGate = null;
	server.profilePutReply = null;
	server.profile = { handle: 'alex', colour: COLOUR };
	server.putPicks = [];
	server.putPicksImpl = null;
	server.putColours = [];
	server.mineReads = 0;
	server.publicReads = 0;
}

const fetchMock = vi.fn();

function reply(body: unknown, status = 200) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const HTML = { ok: true, status: 200, json: async () => Promise.reject(new SyntaxError('html')) };

fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
	const method = init?.method ?? 'GET';
	if (url.includes('/timetable.json')) {
		if (server.timetableGate) await server.timetableGate;
		return reply(tmr26Timetable);
	}
	if (url.includes('/users/me/profile')) {
		if (method === 'PUT' && server.profilePutReply) {
			return reply(server.profilePutReply.body, server.profilePutReply.status);
		}
		if (method === 'PUT') {
			const { colour } = JSON.parse(init!.body as string) as { colour: string };
			server.putColours.push(colour);
			server.profile.colour = colour;
		}
		return reply(server.profile);
	}
	if (url.includes('/users/me/notifications')) {
		return reply({
			leadMinutes: 15,
			notifyMaybe: false,
			notifyOverrides: {},
			enabled: true,
			subscribedHere: false
		});
	}
	if (url.endsWith(`/festivals/${FESTIVAL}/picks/me`)) {
		server.mineReads++;
		const answer = { ...server.mine };
		if (server.mineGate) await server.mineGate;
		return reply({ selections: answer });
	}
	if (url.endsWith(`/festivals/${FESTIVAL}/picks`)) {
		if (method === 'PUT') {
			const { selections } = JSON.parse(init!.body as string) as {
				selections: Record<string, number>;
			};
			server.putPicks.push(selections);
			if (server.putGate) await server.putGate;
			if (server.putPicksImpl) {
				const out = server.putPicksImpl();
				return out.body === HTML ? HTML : reply(out.body, out.status);
			}
			server.mine = selections;
			return reply({ ok: true });
		}
		server.publicReads++;
		return reply(server.publicPicks, server.publicStatus);
	}
	return reply({}, 404);
});

function signIn() {
	session.user = { id: '123', name: 'Alex Example', givenName: 'Alex' };
}

function visit(path: string) {
	history.replaceState(null, '', path);
}

function tapInUrl() {
	return new URL(window.location.href).searchParams.get('tap');
}

/** Let promise continuations land and run timers up to `ms`. */
const advance = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

let space: FestivalSpace;

async function openSpace() {
	space = new FestivalSpace();
	await space.open(FESTIVAL);
	await advance();
	return space;
}

beforeEach(() => {
	vi.useFakeTimers();
	visit('/');
	session.user = null;
	resetServer();
	maybeOpenInstallPromo.mockReset();
	localStorage.clear();
	fetchMock.mockClear();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	space?.dispose();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('signed-out Festival', () => {
	it('loads the Timetable and shows everyone\'s Picks, going before maybe', async () => {
		server.publicPicks = {
			[PERF_A]: [
				{ handle: 'sam', colour: OTHER_COLOUR, state: 2 },
				{ handle: 'kim', colour: COLOUR, state: 1 }
			]
		};
		await openSpace();

		expect(space.timetable.days.length).toBeGreaterThan(0);
		expect(space.picksOf(PERF_A).map((m) => [m.name, m.state])).toEqual([
			['kim', 1],
			['sam', 2]
		]);
		expect(space.goingCount(PERF_A)).toBe(1);
		expect(space.goingCount(PERF_B)).toBe(0);
	});

	it('gives every mark a unique key even when two Attendees share a Handle', async () => {
		server.publicPicks = {
			[PERF_A]: [
				{ handle: '', colour: COLOUR, state: 1 },
				{ handle: '', colour: COLOUR, state: 1 }
			]
		};
		await openSpace();

		const keys = space.picksOf(PERF_A).map((m) => m.userId);
		expect(new Set(keys).size).toBe(2);
	});

	it('lists 50 pickers going-first and counts the rest', async () => {
		server.publicPicks = {
			[PERF_A]: [
				...Array.from({ length: 30 }, (_, i) => ({ handle: `m${i}`, colour: COLOUR, state: 2 })),
				...Array.from({ length: 30 }, (_, i) => ({ handle: `g${i}`, colour: COLOUR, state: 1 }))
			]
		};
		await openSpace();

		const { shown, more } = space.attendees(PERF_A);
		expect(shown).toHaveLength(50);
		expect(more).toBe(10);
		expect(shown.slice(0, 30).every((m) => m.state === 1)).toBe(true);
		expect(space.goingCount(PERF_A)).toBe(30);
	});

	it('a tap asks for sign-in, remembers the tap in the URL and saves nothing', async () => {
		await openSpace();

		space.togglePick(PERF_A);
		await advance(2000);

		expect(space.signInRequired).toBe(true);
		expect(tapInUrl()).toBe(PERF_A);
		expect(space.myState(PERF_A)).toBe(0);
		expect(server.putPicks).toEqual([]);
	});

	it('cancelling sign-in forgets the tap', async () => {
		await openSpace();
		space.togglePick(PERF_A);

		space.cancelSignIn();

		expect(space.signInRequired).toBe(false);
		expect(tapInUrl()).toBeNull();
	});

	it('keeps the last Picks when a poll fails', async () => {
		server.publicPicks = { [PERF_A]: [{ handle: 'kim', colour: COLOUR, state: 1 }] };
		await openSpace();

		server.publicStatus = 500;
		await advance(30_000);

		expect(server.publicReads).toBe(2);
		expect(space.goingCount(PERF_A)).toBe(1);
	});

	it('polls every 30 s, pauses while hidden and reads at once on return', async () => {
		await openSpace();
		expect(server.publicReads).toBe(1);

		await advance(30_000);
		expect(server.publicReads).toBe(2);

		Object.defineProperty(document, 'hidden', { value: true, configurable: true });
		await advance(90_000);
		expect(server.publicReads).toBe(2);

		Object.defineProperty(document, 'hidden', { value: false, configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));
		await advance();
		expect(server.publicReads).toBe(3);
	});
});

describe('Pending Pick across sign-in', () => {
	it('saves the tapped Performance as going, once, and strips the tap', async () => {
		visit(`/festival/tmr26?tap=${PERF_A}`);
		signIn();
		await openSpace();
		await advance(2000);

		expect(server.putPicks).toEqual([{ [PERF_A]: 1 }]);
		expect(space.myState(PERF_A)).toBe(1);
		expect(tapInUrl()).toBeNull();
	});

	it('ignores a tap for a Performance the Timetable does not have', async () => {
		visit('/festival/tmr26?tap=nope');
		signIn();
		await openSpace();
		await advance(2000);

		expect(server.putPicks).toEqual([]);
		expect(tapInUrl()).toBeNull();
	});

	it('does not cycle a Performance the user already picked', async () => {
		visit(`/festival/tmr26?tap=${PERF_A}`);
		server.mine = { [PERF_A]: 2 };
		signIn();
		await openSpace();
		await advance(2000);

		expect(server.putPicks).toEqual([]);
		expect(space.myState(PERF_A)).toBe(2);
	});

	it('shows no Pick as saved when the save fails with handle required, and says why', async () => {
		visit(`/festival/tmr26?tap=${PERF_A}`);
		server.putPicksImpl = () => ({ status: 400, body: { error: 'handle is required' } });
		signIn();
		await openSpace();
		await advance(2000);

		expect(space.myState(PERF_A)).toBe(0);
		expect(space.notice).toMatch(/username/i);
		expect(space.status).not.toBe('pending');
	});

	it('onSignedIn starts the session of a visitor who just signed in without a reload', async () => {
		await openSpace();
		space.togglePick(PERF_A);
		expect(space.signInRequired).toBe(true);

		signIn();
		await space.onSignedIn();
		await advance(2000);

		expect(space.signInRequired).toBe(false);
		expect(server.putPicks).toEqual([{ [PERF_A]: 1 }]);
	});
});

describe('Colour', () => {
	beforeEach(() => {
		server.profile.colour = null;
		signIn();
	});

	it('opens the Colour modal before the first save, then saves with the chosen Colour', async () => {
		await openSpace();

		space.togglePick(PERF_A);
		await advance(2000);
		expect(space.colourRequired).toBe(true);
		expect(server.putPicks).toEqual([]);
		expect(space.myState(PERF_A)).toBe(0);

		await space.chooseColour(OTHER_COLOUR);
		await advance(2000);

		expect(server.putColours).toEqual([OTHER_COLOUR]);
		expect(server.putPicks).toEqual([{ [PERF_A]: 1 }]);
		expect(space.colourRequired).toBe(false);
		expect(space.picksOf(PERF_A)).toEqual([
			expect.objectContaining({ name: 'alex', color: OTHER_COLOUR, state: 1 })
		]);
	});

	it('drops the held Pick when the modal is cancelled', async () => {
		await openSpace();
		space.togglePick(PERF_A);

		space.cancelColour();
		await advance(2000);

		expect(space.colourRequired).toBe(false);
		expect(space.myState(PERF_A)).toBe(0);
		expect(server.putPicks).toEqual([]);
		expect(server.putColours).toEqual([]);
	});

	it('holds the Pending Pick for the modal too', async () => {
		visit(`/festival/tmr26?tap=${PERF_A}`);
		await openSpace();
		await advance(2000);

		expect(space.colourRequired).toBe(true);
		expect(server.putPicks).toEqual([]);

		await space.chooseColour(COLOUR);
		await advance(2000);
		expect(server.putPicks).toEqual([{ [PERF_A]: 1 }]);
	});

	it('never opens for a user who already has a Colour', async () => {
		server.profile.colour = COLOUR;
		await openSpace();

		space.togglePick(PERF_A);
		await advance(2000);

		expect(space.colourRequired).toBe(false);
		expect(server.putPicks).toEqual([{ [PERF_A]: 1 }]);
	});

	it('keeps the edit and opens the modal when the server says to choose a Colour first', async () => {
		server.profile.colour = COLOUR;
		server.putPicksImpl = () => ({ status: 400, body: { error: 'choose a colour first' } });
		await openSpace();

		space.togglePick(PERF_A);
		await advance(2000);

		expect(space.colourRequired).toBe(true);
		expect(space.myState(PERF_A)).toBe(1);
	});

	it('reverts the held Pick and says to set a username when the Colour is refused for no username', async () => {
		await openSpace();
		space.togglePick(PERF_A);
		expect(space.colourRequired).toBe(true);
		server.profilePutReply = { status: 400, body: { error: 'handle is required' } };

		await space.chooseColour(COLOUR);
		await advance(2000);

		expect(space.colourRequired).toBe(false);
		expect(space.notice).toMatch(/username/i);
		expect(space.myState(PERF_A)).toBe(0);
		expect(server.putPicks).toEqual([]);
	});

	it('keeps a failed Colour save open with a notice', async () => {
		await openSpace();
		space.togglePick(PERF_A);
		fetchMock.mockImplementationOnce(async () => reply({ error: 'no' }, 500));

		await space.chooseColour(COLOUR);

		expect(space.colourRequired).toBe(true);
		expect(space.notice).not.toBe('');
	});
});

describe('saving my Picks', () => {
	beforeEach(() => signIn());

	it('cycles going, maybe, off and writes one whole map after the debounce', async () => {
		await openSpace();

		space.togglePick(PERF_A);
		expect(space.myState(PERF_A)).toBe(1);
		space.togglePick(PERF_A);
		expect(space.myState(PERF_A)).toBe(2);
		space.togglePick(PERF_B);
		expect(server.putPicks).toEqual([]);
		expect(space.status).toBe('pending');

		await advance(500);

		expect(server.putPicks).toEqual([{ [PERF_A]: 2, [PERF_B]: 1 }]);
		expect(space.status).toBe('synced');
	});

	it('opens the install promo only after a Pick has been saved', async () => {
		await openSpace();
		space.togglePick(PERF_A);
		expect(maybeOpenInstallPromo).not.toHaveBeenCalled();

		await advance(500);

		expect(maybeOpenInstallPromo).toHaveBeenCalledTimes(1);
	});

	it('never writes before the first read of my Picks, then writes the merged map', async () => {
		let release!: () => void;
		server.mineGate = new Promise<void>((resolve) => (release = resolve));
		server.mine = { [PERF_B]: 2 };
		const opening = (space = new FestivalSpace()).open(FESTIVAL);
		await advance();

		space.togglePick(PERF_A);
		await advance(3000);
		expect(server.putPicks).toEqual([]);

		release();
		await opening;
		await advance(2000);

		expect(server.putPicks).toEqual([{ [PERF_A]: 1, [PERF_B]: 2 }]);
	});

	it('re-reads my Picks on a poll when nothing is pending, and on return to the tab', async () => {
		await openSpace();
		server.mine = { [PERF_C]: 1 };

		await advance(30_000);
		expect(space.myState(PERF_C)).toBe(1);

		server.mine = { [PERF_C]: 2 };
		document.dispatchEvent(new Event('visibilitychange'));
		await advance();
		expect(space.myState(PERF_C)).toBe(2);
	});

	it('does not let a re-read overwrite an edit that is still pending', async () => {
		await openSpace();
		space.togglePick(PERF_A);
		server.mine = { [PERF_C]: 1 };

		document.dispatchEvent(new Event('visibilitychange'));
		await advance(0);
		expect(space.myState(PERF_A)).toBe(1);

		await advance(2000);
		expect(server.putPicks).toEqual([{ [PERF_A]: 1, [PERF_C]: 1 }]);
	});

	it('shows my own Pick once, in my Colour, instead of the public copy', async () => {
		server.mine = { [PERF_A]: 1 };
		server.publicPicks = {
			[PERF_A]: [
				{ handle: 'alex', colour: '#000000', state: 2 },
				{ handle: 'sam', colour: OTHER_COLOUR, state: 2 }
			]
		};
		await openSpace();

		const marks = space.picksOf(PERF_A);
		expect(marks.map((m) => [m.name, m.state, m.color])).toEqual([
			['alex', 1, COLOUR],
			['sam', 2, OTHER_COLOUR]
		]);
		expect(space.goingCount(PERF_A)).toBe(1);
	});

	it('lists my Picks, going and maybe, in time order and nobody else\'s', async () => {
		server.mine = { [LATE_PERF]: 2, [PERF_A]: 1 };
		server.publicPicks = { [PERF_C]: [{ handle: 'sam', colour: COLOUR, state: 1 }] };
		await openSpace();

		const ids = space.myPicks.flatMap((g) => g.rows.map((r) => r.performance.id));
		expect(ids).toEqual([PERF_A, LATE_PERF]);
	});

	it('keeps pending Picks across a reload', async () => {
		await openSpace();
		space.togglePick(PERF_A);
		space.dispose();

		await openSpace();
		await advance(2000);

		expect(server.putPicks).toEqual([{ [PERF_A]: 1 }]);
	});

	it('stops retrying and shows an error after three failed saves', async () => {
		server.putPicksImpl = () => ({ status: 200, body: HTML });
		await openSpace();

		space.togglePick(PERF_A);
		await advance(500);
		await advance(30_000);
		await advance(30_000);
		expect(server.putPicks).toHaveLength(3);
		expect(space.status).toBe('error');

		await advance(120_000);
		expect(server.putPicks).toHaveLength(3);
	});

	it('asks to sign in again when the session has expired', async () => {
		server.putPicksImpl = () => ({ status: 401, body: { message: 'Unauthorized' } });
		await openSpace();

		space.togglePick(PERF_A);
		await advance(500);
		await advance(60_000);

		expect(server.putPicks).toHaveLength(1);
		expect(space.status).toBe('error');
		expect(space.notice).toMatch(/sign/i);
	});
});

describe('ordering races', () => {
	beforeEach(() => signIn());

	it('applies the Pending Pick even when the Timetable loads after profile and picks/me', async () => {
		visit(`/festival/tmr26?tap=${PERF_A}`);
		let release!: () => void;
		server.timetableGate = new Promise<void>((resolve) => (release = resolve));
		space = new FestivalSpace();
		const opening = space.open(FESTIVAL);
		await advance(100);
		expect(server.putPicks).toEqual([]);

		release();
		await opening;
		await advance(2000);

		expect(space.myState(PERF_A)).toBe(1);
		expect(server.putPicks).toEqual([{ [PERF_A]: 1 }]);
		expect(tapInUrl()).toBeNull();
	});

	it('ignores a picks/me answer that arrives while a save is in flight', async () => {
		await openSpace();
		server.mine = { [PERF_C]: 1 };
		let releaseRead!: () => void;
		let releasePut!: () => void;
		server.mineGate = new Promise<void>((resolve) => (releaseRead = resolve));
		server.putGate = new Promise<void>((resolve) => (releasePut = resolve));
		space.togglePick(PERF_A);
		await advance(500);
		expect(server.putPicks).toHaveLength(1);

		document.dispatchEvent(new Event('visibilitychange'));
		await advance();
		releaseRead();
		await advance();
		expect(space.myState(PERF_C)).toBe(0);

		releasePut();
		await advance();
		expect(space.myState(PERF_A)).toBe(1);
	});

	it('ignores a picks/me answer that was asked for before a save and arrives after it', async () => {
		await openSpace();
		let releaseRead!: () => void;
		server.mineGate = new Promise<void>((resolve) => (releaseRead = resolve));
		document.dispatchEvent(new Event('visibilitychange'));
		await advance();
		server.mineGate = null;

		space.togglePick(PERF_A);
		await advance(500);
		expect(server.putPicks).toEqual([{ [PERF_A]: 1 }]);

		releaseRead();
		await advance();
		expect(space.myState(PERF_A)).toBe(1);
	});

	it('keeps an edit made while a rejected save was in flight', async () => {
		server.putPicksImpl = () => ({ status: 400, body: { error: 'nope' } });
		await openSpace();
		let releasePut!: () => void;
		server.putGate = new Promise<void>((resolve) => (releasePut = resolve));
		space.togglePick(PERF_A);
		await advance(500);

		space.togglePick(PERF_B);
		releasePut();
		await advance();

		expect(space.myState(PERF_A)).toBe(0);
		expect(space.myState(PERF_B)).toBe(1);
	});
});

describe('view', () => {
	it('deep-links to a Performance: switches Day and highlights it', async () => {
		await openSpace();
		const laterDay = tmr26Timetable.days[1]!.performances[0]!.id;

		space.setViewMode('picks');
		expect(space.focusPerformance(laterDay)).toBe(true);

		expect(space.viewMode).toBe('full');
		expect(space.currentDayIdx).toBe(1);
		expect(space.highlightedPerfId).toBe(laterDay);
		expect(space.focusPerformance('nope')).toBe(false);
	});

	it('opens and closes the map overlay', async () => {
		await openSpace();
		space.openMap();
		expect(space.mapOpen).toBe(true);
		space.handlePopState();
		expect(space.mapOpen).toBe(false);
	});
});
