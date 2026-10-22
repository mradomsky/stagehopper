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

type Row = { userId: string; nickname: string; colour: string; state: number };

/** Scripted backend: what each route answers, and what the client sent. */
const server = {
	publicPicks: {} as Record<string, Row[]>,
	publicStatus: 200,
	mine: {} as Record<string, number>,
	mineGate: null as Promise<void> | null,
	putGate: null as Promise<void> | null,
	timetableGate: null as Promise<void> | null,
	profilePutReply: null as null | { status: number; body: unknown },
	profile: { nickname: 'alex', colour: COLOUR as string | null },
	putPicks: [] as Array<Record<string, number>>,
	putPicksImpl: null as null | (() => { status: number; body: unknown }),
	putColours: [] as string[],
	mineReads: 0,
	publicReads: 0,
	notifications: freshNotifications()
};

function freshNotifications() {
	return {
		settings: {
			leadMinutes: 15,
			notifyMaybe: false,
			notifyOverrides: {} as Record<string, boolean>,
			enabled: true,
			subscribedHere: false
		},
		/** Statuses to answer the next reads with, then 200. */
		readStatuses: [] as number[],
		putStatus: 200,
		/** One gate per bell write, in order; an unset entry answers at once. */
		putGates: [] as Array<Promise<void> | undefined>,
		reads: 0,
		puts: [] as Array<Record<string, unknown>>
	};
}

function resetServer() {
	server.publicPicks = {};
	server.publicStatus = 200;
	server.mine = {};
	server.mineGate = null;
	server.putGate = null;
	server.timetableGate = null;
	server.profilePutReply = null;
	server.profile = { nickname: 'alex', colour: COLOUR };
	server.putPicks = [];
	server.putPicksImpl = null;
	server.putColours = [];
	server.mineReads = 0;
	server.publicReads = 0;
	server.notifications = freshNotifications();
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
		const n = server.notifications;
		if (method === 'PUT') {
			n.puts.push(JSON.parse(init!.body as string) as Record<string, unknown>);
			const gate = n.putGates[n.puts.length - 1];
			const status = n.putStatus;
			if (gate) await gate;
			return reply({ ok: true }, status);
		}
		n.reads++;
		const status = n.readStatuses.shift() ?? 200;
		return reply(status === 200 ? n.settings : {}, status);
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

function signIn(id = '123') {
	session.user = { id, name: 'Alex Example', givenName: 'Alex' };
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
				{ userId: 'clerk:sam', nickname: 'sam', colour: OTHER_COLOUR, state: 2 },
				{ userId: 'clerk:kim', nickname: 'kim', colour: COLOUR, state: 1 }
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
				{ userId: 'clerk:a', nickname: '', colour: COLOUR, state: 1 },
				{ userId: 'clerk:b', nickname: '', colour: COLOUR, state: 1 }
			]
		};
		await openSpace();

		const keys = space.picksOf(PERF_A).map((m) => m.userId);
		expect(new Set(keys).size).toBe(2);
	});

	it('keys each mark by its user id, and invents a key only for a row without one', async () => {
		server.publicPicks = {
			[PERF_A]: [
				{ userId: 'clerk:a', nickname: 'sam', colour: COLOUR, state: 1 },
				{ userId: '', nickname: 'sam', colour: COLOUR, state: 1 }
			]
		};
		await openSpace();

		const keys = space.picksOf(PERF_A).map((m) => m.userId);
		expect(keys[0]).toBe('clerk:a');
		expect(new Set(keys).size).toBe(2);
	});

	it('lists 50 pickers going-first and counts the rest', async () => {
		server.publicPicks = {
			[PERF_A]: [
				...Array.from({ length: 30 }, (_, i) => ({ userId: `clerk:m${i}`, nickname: `m${i}`, colour: COLOUR, state: 2 })),
				...Array.from({ length: 30 }, (_, i) => ({ userId: `clerk:g${i}`, nickname: `g${i}`, colour: COLOUR, state: 1 }))
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
		server.publicPicks = { [PERF_A]: [{ userId: 'clerk:kim', nickname: 'kim', colour: COLOUR, state: 1 }] };
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

describe('unknown Festival', () => {
	it('is not found: no Timetable, no Picks read, no save', async () => {
		signIn();
		space = new FestivalSpace();
		await space.open('bogus');
		await advance(60_000);

		expect(space.notFound).toBe(true);
		expect(space.timetableLoading).toBe(false);
		space.togglePick(PERF_A);
		await advance(2000);

		const urls = fetchMock.mock.calls.map(([url]) => String(url));
		expect(urls.some((url) => url.includes('/picks') || url.includes('timetable.json'))).toBe(false);
		expect(server.putPicks).toEqual([]);
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
		server.putPicksImpl = () => ({ status: 400, body: { error: 'nickname is required' } });
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
		server.profilePutReply = { status: 400, body: { error: 'nickname is required' } };

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
		expect(space.colourError).not.toBe('');
		expect(space.notice).toBe('');
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

	it('keeps my public row until my own Picks have loaded', async () => {
		let release!: () => void;
		server.mineGate = new Promise<void>((resolve) => (release = resolve));
		server.mine = { [PERF_A]: 1 };
		server.publicPicks = {
			[PERF_A]: [{ userId: 'clerk:123', handle: 'alex', colour: COLOUR, state: 1 }]
		};
		const opening = (space = new FestivalSpace()).open(FESTIVAL);
		await advance();

		expect(space.picksOf(PERF_A)).toHaveLength(1);

		release();
		await opening;
		await advance();
		expect(space.picksOf(PERF_A).map((m) => m.userId)).toEqual(['self']);
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
				{ userId: 'clerk:123', nickname: 'alex', colour: '#000000', state: 2 },
				{ userId: 'clerk:sam', nickname: 'sam', colour: OTHER_COLOUR, state: 2 }
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

	it('still shows another Attendee who shares my Handle', async () => {
		server.mine = { [PERF_A]: 1 };
		server.publicPicks = {
			[PERF_A]: [
				{ userId: 'clerk:123', nickname: 'alex', colour: COLOUR, state: 1 },
				{ userId: 'clerk:other', nickname: 'alex', colour: OTHER_COLOUR, state: 2 }
			]
		};
		await openSpace();

		expect(space.picksOf(PERF_A).map((m) => [m.userId, m.state])).toEqual([
			['self', 1],
			['clerk:other', 2]
		]);
	});

	it('drops my public row once even when it carries an old Handle', async () => {
		server.mine = { [PERF_A]: 1 };
		server.publicPicks = {
			[PERF_A]: [{ userId: 'clerk:123', nickname: 'old-alex', colour: COLOUR, state: 1 }]
		};
		await openSpace();

		expect(space.picksOf(PERF_A).map((m) => m.userId)).toEqual(['self']);
		expect(space.goingCount(PERF_A)).toBe(1);
	});

	it('treats no row as mine when the rows carry no user id', async () => {
		server.mine = { [PERF_A]: 1 };
		server.publicPicks = {
			[PERF_A]: [{ userId: '', nickname: 'alex', colour: COLOUR, state: 2 }]
		};
		await openSpace();

		expect(space.picksOf(PERF_A).map((m) => m.state)).toEqual([1, 2]);
	});

	it('lists my Picks, going and maybe, in time order and nobody else\'s', async () => {
		server.mine = { [LATE_PERF]: 2, [PERF_A]: 1 };
		server.publicPicks = { [PERF_C]: [{ userId: 'clerk:sam', nickname: 'sam', colour: COLOUR, state: 1 }] };
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

describe('re-authentication', () => {
	beforeEach(() => signIn());

	/** A Festival whose first save the gateway has just rejected. */
	async function expiredSession() {
		server.putPicksImpl = () => ({ status: 401, body: { message: 'Unauthorized' } });
		await openSpace();
		space.togglePick(PERF_A);
		await advance(500);
		expect(space.notice).toMatch(/sign/i);
		return space;
	}

	it('keeps the Picks made before the session expired', async () => {
		await expiredSession();
		expect(space.myState(PERF_A)).toBe(1);
	});

	it('spends one request on the rejection, however long the page stays open', async () => {
		await expiredSession();
		await advance(120_000);
		expect(server.putPicks).toHaveLength(1);
	});

	it('retries the save once the same account has signed in again', async () => {
		await expiredSession();
		server.putPicksImpl = null;

		await space.onSignedIn();
		await advance();

		expect(server.putPicks).toHaveLength(2);
		expect(server.putPicks[1]).toEqual({ [PERF_A]: 1 });
		expect(space.notice).toBe('');
		expect(space.status).toBe('synced');
	});

	it('gives a later expiry its own retry once a save has gone through', async () => {
		await expiredSession();
		server.putPicksImpl = null;
		await space.onSignedIn();
		await advance();
		expect(space.hasPendingWrite).toBe(false);

		server.putPicksImpl = () => ({ status: 401, body: { message: 'Unauthorized' } });
		space.togglePick(PERF_B);
		await advance(500);
		expect(space.notice).toMatch(/sign/i);
		server.putPicksImpl = null;
		server.putPicks.length = 0;

		await space.onSignedIn();
		await advance();

		expect(server.putPicks).toHaveLength(1);
		expect(space.myState(PERF_B)).toBe(1);
	});

	// The Picks are keyed to one account. Accepting a different one would write this user's
	// unsaved Picks under someone else's key, silently.
	it('does not save the first account Picks under a different account', async () => {
		await expiredSession();
		server.putPicksImpl = null;
		server.putPicks.length = 0;

		signIn('someone-else');
		await space.onSignedIn();
		await advance(60_000);

		expect(server.putPicks.filter((map) => PERF_A in map)).toEqual([]);
		expect(space.myState(PERF_A)).toBe(0);
	});

	it('still retries for the right account after a wrong one tried first', async () => {
		await expiredSession();
		server.putPicksImpl = null;
		server.putPicks.length = 0;

		signIn('someone-else');
		await space.onSignedIn();
		await advance();
		signIn();
		await space.onSignedIn();
		await advance(1000);

		expect(server.putPicks).toEqual([{ [PERF_A]: 1 }]);
	});

	// A rejection a sign-in cannot fix (the gateway dropping the header, a mis-scoped token)
	// must not re-arm the sign-in prompt, or the page would loop on it.
	it('does not re-open the sign-in prompt when the retry is rejected too', async () => {
		await expiredSession();

		await space.onSignedIn();
		await advance(60_000);

		expect(space.signInRequired).toBe(false);
		expect(space.status).toBe('error');
		expect(server.putPicks).toHaveLength(2);
	});

	it('does nothing when told of a sign-in that did not happen', async () => {
		await expiredSession();
		server.putPicksImpl = null;
		session.user = null;

		await space.onSignedIn();
		await advance(60_000);

		expect(server.putPicks).toHaveLength(1);
	});
});

describe('the Picks tab', () => {
	// The clock sits at 12:30 on the fixture's second day, so these are, in order:
	// Cici Daze (day 18, 12:00-13:30), Makasi (day 18, 13:00-14:00), Lucas & Steve
	// (day 18, 20:00-21:00), and DJORA on day 17, a day already finished.
	const NOW_PICK = '2650343511';
	const SOON_PICK = '2934445051';
	const FUTURE_PICK = '2655235930';
	const PAST_DAY_PICK = '3006649694';

	async function openAt(hour: number, minute: number) {
		vi.setSystemTime(new Date(2026, 6, 18, hour, minute));
		signIn();
		await openSpace();
		space.tickNow();
	}

	it('groups only marked performances by day, tagged with their timing', async () => {
		await openAt(12, 30);
		for (const id of [NOW_PICK, SOON_PICK, FUTURE_PICK, PAST_DAY_PICK]) space.togglePick(id);

		expect(space.myPicks.map((g) => g.date)).toEqual(['2026-07-17', '2026-07-18']);
		const timingById = Object.fromEntries(
			space.myPicks
				.find((g) => g.date === '2026-07-18')!
				.rows.map((r) => [r.performance.id, r.timing])
		);
		expect(timingById[NOW_PICK]).toBe('now');
		expect(timingById[SOON_PICK]).toBe('soon');
		expect(timingById[FUTURE_PICK]).toBe('future');
		expect(space.myPicks.find((g) => g.date === '2026-07-17')!.rows[0]!.timing).toBe('past');
	});

	it('scrolls to the first pick that has not ended yet', async () => {
		await openAt(12, 30);
		space.togglePick(PAST_DAY_PICK);
		space.togglePick(NOW_PICK);

		expect(space.pickScrollTargetId).toBe(NOW_PICK);
	});

	it('has no scroll target once every pick is in the past', async () => {
		await openAt(12, 30);
		space.togglePick(PAST_DAY_PICK);

		expect(space.pickScrollTargetId).toBeNull();
	});

	it('reports the festival day currently in progress as todayDate', async () => {
		await openAt(12, 30);

		expect(space.todayDate).toBe('2026-07-18');
	});

	it('reclassifies a pick as the clock ticks forward, with no change to the mark itself', async () => {
		await openAt(12, 30);
		space.togglePick(SOON_PICK);
		const timingFor = () =>
			space.myPicks
				.find((g) => g.date === '2026-07-18')
				?.rows.find((r) => r.performance.id === SOON_PICK)?.timing;
		expect(timingFor()).toBe('soon');

		// Makasi runs 13:00-14:00; the tick alone moves it through 'now' and on to 'past'.
		vi.setSystemTime(new Date(2026, 6, 18, 13, 15));
		space.tickNow();
		expect(timingFor()).toBe('now');

		vi.setSystemTime(new Date(2026, 6, 18, 14, 15));
		space.tickNow();
		expect(timingFor()).toBe('past');
	});
});

describe('notifications', () => {
	it('fetches settings once while opening, and not again on Picks open', async () => {
		signIn();
		server.notifications.settings.notifyMaybe = true;
		await openSpace();

		expect(space.notificationSettings?.notifyMaybe).toBe(true);
		space.setViewMode('picks');
		await advance();

		expect(server.notifications.reads).toBe(1);
	});

	it('never fetches for a guest: there is no account to have push settings', async () => {
		await openSpace();
		space.setViewMode('picks');
		await advance();

		expect(server.notifications.reads).toBe(0);
	});

	it('leaves the page alone when the settings fetch is rejected as unauthorized', async () => {
		signIn();
		server.notifications.readStatuses = [401];
		await openSpace();

		expect(space.notificationSettings).toBeNull();
		expect(space.notice).toBe('');
		expect(space.signInRequired).toBe(false);
	});

	it('retries after a failed load, the next time something asks', async () => {
		signIn();
		server.notifications.readStatuses = [500];
		await openSpace();
		expect(space.notificationSettings).toBeNull();

		space.ensureNotificationSettingsLoaded();
		await advance();

		expect(server.notifications.reads).toBe(2);
		expect(space.notificationSettings).not.toBeNull();
	});

	describe('notifyStateOf', () => {
		async function pickedSpace(settings: Partial<typeof server.notifications.settings> = {}) {
			signIn();
			Object.assign(server.notifications.settings, settings);
			await openSpace();
			space.togglePick(PERF_A); // going
		}

		it('is false for an unmarked performance', async () => {
			await pickedSpace();
			expect(space.notifyStateOf('not-marked')).toBe(false);
		});

		it('going notifies by default, regardless of notifyMaybe', async () => {
			await pickedSpace({ notifyMaybe: false });
			expect(space.notifyStateOf(PERF_A)).toBe(true);
		});

		it('maybe notifies only when notifyMaybe is on', async () => {
			await pickedSpace({ notifyMaybe: false });
			space.togglePick(PERF_A); // maybe
			expect(space.notifyStateOf(PERF_A)).toBe(false);
		});

		it('an override replaces the default', async () => {
			await pickedSpace({ notifyOverrides: { [PERF_A]: false } });
			expect(space.notifyStateOf(PERF_A)).toBe(false);
		});
	});

	describe('toggleNotifyOverride', () => {
		it('flips the effective state and writes an explicit override', async () => {
			signIn();
			await openSpace();
			space.togglePick(PERF_A);

			space.toggleNotifyOverride(PERF_A);
			await advance();

			expect(space.notifyStateOf(PERF_A)).toBe(false);
			expect(server.notifications.puts).toEqual([{ notifyOverrides: { [PERF_A]: false } }]);
		});

		it('sends null (removing the key) when toggling back to the default', async () => {
			signIn();
			server.notifications.settings.notifyOverrides = { [PERF_A]: false };
			await openSpace();
			space.togglePick(PERF_A);
			expect(space.notifyStateOf(PERF_A)).toBe(false);

			space.toggleNotifyOverride(PERF_A);
			await advance();

			expect(space.notifyStateOf(PERF_A)).toBe(true);
			expect(server.notifications.puts).toEqual([{ notifyOverrides: { [PERF_A]: null } }]);
		});

		it('does nothing when push is off for the account', async () => {
			signIn();
			server.notifications.settings.enabled = false;
			await openSpace();
			space.togglePick(PERF_A);

			space.toggleNotifyOverride(PERF_A);
			await advance();

			expect(server.notifications.puts).toEqual([]);
		});

		it('does nothing for a performance that is not marked', async () => {
			signIn();
			await openSpace();

			space.toggleNotifyOverride('not-marked');
			await advance();

			expect(server.notifications.puts).toEqual([]);
		});

		it('reverts the optimistic change and says so when the write fails', async () => {
			signIn();
			await openSpace();
			space.togglePick(PERF_A);
			server.notifications.putStatus = 500;

			space.toggleNotifyOverride(PERF_A);
			expect(space.notifyStateOf(PERF_A)).toBe(false);
			await advance();

			expect(space.notifyStateOf(PERF_A)).toBe(true);
			expect(space.notice).toMatch(/reminders/i);
		});

		it('asks to sign in again when the write is rejected as unauthorized', async () => {
			signIn();
			await openSpace();
			space.togglePick(PERF_A);
			server.notifications.putStatus = 401;

			space.toggleNotifyOverride(PERF_A);
			await advance();

			expect(space.notifyStateOf(PERF_A)).toBe(true);
			expect(space.notice).toMatch(/sign/i);
		});

		it('says so, without a crash, when the session is gone at write time', async () => {
			signIn();
			await openSpace();
			space.togglePick(PERF_A);
			await advance(500);
			session.user = null; // cleared between load and tap

			space.toggleNotifyOverride(PERF_A);
			await advance();

			expect(space.notifyStateOf(PERF_A)).toBe(true); // reverted
			expect(space.notice).toMatch(/sign/i);
		});

		it('a stale response from an earlier toggle does not clobber a later one', async () => {
			signIn();
			await openSpace();
			space.togglePick(PERF_A);
			let releaseFirst!: () => void;
			server.notifications.putGates = [new Promise<void>((resolve) => (releaseFirst = resolve))];
			server.notifications.putStatus = 500;

			space.toggleNotifyOverride(PERF_A); // off, write 1 held and doomed
			server.notifications.putStatus = 200;
			space.toggleNotifyOverride(PERF_A); // back to the default, write 2
			await advance();
			expect(space.notifyStateOf(PERF_A)).toBe(true);

			// Write 1 fails after write 2 has settled: it must not revert the newer state.
			releaseFirst();
			await advance();
			expect(space.notifyStateOf(PERF_A)).toBe(true);
		});
	});

	describe('setNotificationSettings', () => {
		it('merges onto the existing cache instead of replacing it', async () => {
			signIn();
			server.notifications.settings.notifyOverrides = { [PERF_A]: true };
			await openSpace();

			space.setNotificationSettings({ leadMinutes: 30, notifyMaybe: true });

			expect(space.notificationSettings).toMatchObject({
				leadMinutes: 30,
				notifyMaybe: true,
				notifyOverrides: { [PERF_A]: true },
				enabled: true
			});
		});

		it('falls back to sensible defaults when nothing was cached yet', () => {
			space = new FestivalSpace();

			space.setNotificationSettings({ enabled: true });

			expect(space.notificationSettings).toMatchObject({
				leadMinutes: 15,
				notifyMaybe: false,
				notifyOverrides: {},
				enabled: true
			});
		});
	});
});
