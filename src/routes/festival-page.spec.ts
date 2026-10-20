import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { resetMockPage, setMockPage } from '../test-support/app-state.svelte.js';
import { resetSession, setSessionUser } from '../test-support/auth-session.svelte.js';
import { DEFAULT_FESTIVALS, FESTIVALS, normalizeFestival } from '$lib/stagehopper/festivals.svelte.js';
import tmr26Timetable from '../test-support/fixtures/timetable-tmr26.json';

const goto = vi.fn();
const fetchMock = vi.fn();

vi.mock('$app/navigation', () => ({ goto: (...args: unknown[]) => goto(...args) }));
vi.mock('$app/environment', () => ({ browser: true, building: false, dev: true }));
vi.mock('$app/state', async () => {
	const { mockPage } = await import('../test-support/app-state.svelte.js');
	return { page: mockPage };
});
vi.mock('$lib/stagehopper/auth.svelte.js', async () => {
	const { mockAuthModule } = await import('../test-support/auth-session.svelte.js');
	return mockAuthModule();
});

const { default: FestivalPage } = await import('./festival/[id]/+page.svelte');

const PERF_A = '3006621839';
const PERF_B = '3006649694';
const DAY1_PERF = tmr26Timetable.days[1]!.performances[0]!.id;
const LATE = tmr26Timetable.days[0]!.performances.at(-1)!;
const LATE_PERF = LATE.id;
const LATE_NAME = LATE.artist;
const COLOUR = '#e74c3c';
const BLUE = '#3498db';

type Row = { handle: string; colour: string; state: number };
const server = {
	publicPicks: {} as Record<string, Row[]>,
	mine: {} as Record<string, number>,
	profile: { handle: 'alex', colour: COLOUR as string | null },
	putPicks: [] as Array<Record<string, number>>,
	putColours: [] as string[],
	putPicksReply: null as null | { status: number; body: unknown },
	timetableReply: null as null | { status: number; body: unknown }
};

function reply(body: unknown, status = 200) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
	const method = init?.method ?? 'GET';
	if (url.includes('/timetable.json')) {
		if (server.timetableReply) return reply(server.timetableReply.body, server.timetableReply.status);
		return reply(tmr26Timetable);
	}
	if (url.includes('/users/me/profile')) {
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
			enabled: false,
			subscribedHere: false
		});
	}
	if (url.endsWith('/festivals/tmr26/picks/me')) return reply({ selections: server.mine });
	if (url.endsWith('/festivals/tmr26/picks')) {
		if (method === 'PUT') {
			const body = JSON.parse(init!.body as string) as { selections: Record<string, number> };
			server.putPicks.push(body.selections);
			if (server.putPicksReply) return reply(server.putPicksReply.body, server.putPicksReply.status);
			return reply({ ok: true });
		}
		return reply(server.publicPicks);
	}
	return reply({}, 404);
});

function block(id: string): HTMLElement {
	const el = document.getElementById(`perf-${id}`);
	if (!el) throw new Error(`no block for ${id}`);
	return el;
}

async function tapStar(id: string) {
	await fireEvent.pointerUp(within(block(id)).getByRole('button', { name: /^Mark as/ }));
}

async function renderPage() {
	render(FestivalPage);
	await waitFor(() => expect(document.getElementById(`perf-${PERF_A}`)).not.toBeNull());
}

async function openMenuItem(label: string | RegExp) {
	await fireEvent.click(screen.getAllByRole('button', { name: 'More options' })[0]!);
	await fireEvent.click(await screen.findByRole('button', { name: label }));
}

beforeEach(() => {
	resetSession();
	goto.mockReset();
	fetchMock.mockClear();
	server.publicPicks = {};
	server.mine = {};
	server.profile = { handle: 'alex', colour: COLOUR };
	server.putPicks = [];
	server.putColours = [];
	server.putPicksReply = null;
	server.timetableReply = null;
	history.replaceState(null, '', '/festival/tmr26');
	vi.stubGlobal('fetch', fetchMock);
	resetMockPage();
	setMockPage({ params: { id: 'tmr26' } });
	FESTIVALS.splice(
		0,
		FESTIVALS.length,
		...DEFAULT_FESTIVALS.map((r) => normalizeFestival(r, '2026-01-01'))
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('festival page, signed out', () => {
	it("shows the Timetable with other people's Picks and the going count", async () => {
		server.publicPicks = {
			[PERF_A]: [
				{ handle: 'kim', colour: COLOUR, state: 1 },
				{ handle: 'sam', colour: BLUE, state: 2 }
			]
		};
		await renderPage();

		const pill = await within(block(PERF_A)).findByRole('button', {
			name: '1 going — tap for names'
		});
		expect(pill).toBeInTheDocument();
		expect(within(block(PERF_A)).getByTitle('kim')).toBeInTheDocument();
		expect(within(block(PERF_A)).queryByTitle('sam')).toBeNull();
	});

	it('lists 50 pickers going-first with "and 10 more"; the pill counts those going', async () => {
		server.publicPicks = {
			[PERF_A]: [
				...Array.from({ length: 30 }, (_, i) => ({ handle: `m${i}`, colour: COLOUR, state: 2 })),
				...Array.from({ length: 30 }, (_, i) => ({ handle: `g${i}`, colour: COLOUR, state: 1 }))
			]
		};
		await renderPage();

		const pill = await within(block(PERF_A)).findByRole('button', {
			name: '30 going — tap for names'
		});
		await fireEvent.pointerUp(pill);

		const popover = await screen.findByRole('dialog', { name: "Who's going" });
		expect(within(popover).getAllByRole('listitem')).toHaveLength(51);
		expect(within(popover).getAllByRole('listitem')[0]).toHaveTextContent('g0');
		expect(within(popover).getByText('and 10 more')).toBeInTheDocument();
	});

	it('asks a Visitor to sign in on tap and saves nothing', async () => {
		await renderPage();

		await tapStar(PERF_A);

		expect(await screen.findByRole('dialog', { name: 'Sign in to continue' })).toBeInTheDocument();
		expect(server.putPicks).toEqual([]);
	});

	it('saves the tapped Performance as going once sign-in completes', async () => {
		await renderPage();
		await tapStar(PERF_A);
		await screen.findByRole('dialog', { name: 'Sign in to continue' });

		setSessionUser();

		await waitFor(() => expect(server.putPicks).toEqual([{ [PERF_A]: 1 }]));
		expect(screen.queryByRole('dialog', { name: 'Sign in to continue' })).toBeNull();
		expect(within(block(PERF_A)).getByTitle('alex')).toBeInTheDocument();
	});
});

describe('festival page, Pending Pick after a redirect', () => {
	it('saves the Pick the URL carries and shows it as mine', async () => {
		history.replaceState(null, '', `/festival/tmr26?tap=${PERF_A}`);
		setSessionUser();
		await renderPage();

		await waitFor(() => expect(server.putPicks).toEqual([{ [PERF_A]: 1 }]));
		expect(new URL(location.href).searchParams.get('tap')).toBeNull();
		const dot = within(block(PERF_A)).getByTitle('alex');
		expect(dot.getAttribute('style')).toMatch(/rgba\(231, ?76, ?60/);
	});

	it('tells the user to set a username and does not show the Pick as saved on 400', async () => {
		history.replaceState(null, '', `/festival/tmr26?tap=${PERF_A}`);
		server.putPicksReply = { status: 400, body: { error: 'handle is required' } };
		setSessionUser();
		await renderPage();

		expect(await screen.findByText(/username/i)).toBeInTheDocument();
		expect(within(block(PERF_A)).queryByTitle('alex')).toBeNull();
		expect(within(block(PERF_A)).getByRole('button', { name: 'Mark as going' })).toBeInTheDocument();
	});
});

describe('festival page, Colour', () => {
	beforeEach(() => setSessionUser());

	it('asks for a Colour before the first save, then draws my Pick in it', async () => {
		server.profile.colour = null;
		await renderPage();

		await tapStar(PERF_A);
		const modal = await screen.findByRole('dialog', { name: 'Choose your colour' });
		expect(server.putPicks).toEqual([]);

		await fireEvent.click(within(modal).getByRole('button', { name: `Colour ${BLUE}` }));

		await waitFor(() => expect(server.putPicks).toEqual([{ [PERF_A]: 1 }]));
		expect(server.putColours).toEqual([BLUE]);
		expect(screen.queryByRole('dialog', { name: 'Choose your colour' })).toBeNull();
		const dot = within(block(PERF_A)).getByTitle('alex');
		expect(dot.getAttribute('style')).toMatch(/rgba\(52, ?152, ?219/);
	});

	it('drops the Pick when the modal is cancelled', async () => {
		server.profile.colour = null;
		await renderPage();
		await tapStar(PERF_A);
		const modal = await screen.findByRole('dialog', { name: 'Choose your colour' });

		await fireEvent.click(within(modal).getByRole('button', { name: 'Cancel' }));

		expect(screen.queryByRole('dialog', { name: 'Choose your colour' })).toBeNull();
		expect(within(block(PERF_A)).getByRole('button', { name: 'Mark as going' })).toBeInTheDocument();
		expect(server.putPicks).toEqual([]);
	});

	it('never opens for a user who has a Colour', async () => {
		await renderPage();
		await waitFor(() =>
			expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/picks/me'))).toBe(true)
		);

		await tapStar(PERF_A);

		await waitFor(() => expect(server.putPicks).toEqual([{ [PERF_A]: 1 }]));
		expect(screen.queryByRole('dialog', { name: 'Choose your colour' })).toBeNull();
	});

	it('lets the user change Colour from the menu', async () => {
		await renderPage();
		await waitFor(() =>
			expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/users/me/profile'))).toBe(true)
		);

		await openMenuItem('Colour');
		const modal = await screen.findByRole('dialog', { name: 'Choose your colour' });
		await fireEvent.click(within(modal).getByRole('button', { name: `Colour ${BLUE}` }));

		await waitFor(() => expect(server.putColours).toEqual([BLUE]));
	});
});

describe('festival page, pill and states', () => {
	it('draws only those going on the pill; maybe shows in the popover', async () => {
		server.publicPicks = {
			[PERF_A]: [
				{ handle: 'g1', colour: COLOUR, state: 1 },
				{ handle: 'g2', colour: COLOUR, state: 1 },
				{ handle: 'g3', colour: COLOUR, state: 1 },
				{ handle: 'm1', colour: BLUE, state: 2 },
				{ handle: 'm2', colour: BLUE, state: 2 }
			]
		};
		await renderPage();

		const pill = await within(block(PERF_A)).findByRole('button', {
			name: '3 going — tap for names'
		});
		expect(within(pill).getAllByTitle(/^g\d$/)).toHaveLength(3);
		expect(within(pill).queryByTitle('m1')).toBeNull();
		expect(within(pill).queryByText(/^\+/)).toBeNull();

		await fireEvent.pointerUp(pill);
		const popover = await screen.findByRole('dialog', { name: "Who's going" });
		expect(within(popover).getAllByRole('listitem')).toHaveLength(5);
	});

	it('keeps the menu reachable when the Festival has no timetable file', async () => {
		server.timetableReply = { status: 404, body: {} };
		FESTIVALS.splice(
			0,
			1,
			normalizeFestival({ ...DEFAULT_FESTIVALS[0]!, description: 'Four days of music.' }, '2026-01-01')
		);
		render(FestivalPage);

		expect(await screen.findByText(/Could not load the timetable/)).toBeInTheDocument();
		await openMenuItem('Description and dates');
		expect(await screen.findByText('Four days of music.')).toBeInTheDocument();
	});

	it('shows an empty state and keeps the menu when the Timetable has no days', async () => {
		server.timetableReply = { status: 200, body: { formatVersion: 1, festivalId: 'tmr26', days: [] } };
		render(FestivalPage);

		expect(await screen.findByText(/not published yet/)).toBeInTheDocument();
		await fireEvent.click(screen.getAllByRole('button', { name: 'More options' })[0]!);
		expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
	});

	it('does not show an earlier notice in the Colour modal opened from the menu', async () => {
		history.replaceState(null, '', `/festival/tmr26?tap=${PERF_A}`);
		server.putPicksReply = { status: 400, body: { error: 'handle is required' } };
		setSessionUser();
		await renderPage();
		expect(await screen.findByText(/username/i)).toBeInTheDocument();

		await openMenuItem('Colour');
		const modal = await screen.findByRole('dialog', { name: 'Choose your colour' });

		expect(within(modal).queryByText(/username|signed out|Couldn't/i)).toBeNull();
	});
});

describe('festival page, menu and views', () => {
	it('offers description, dates, map, share and sign in from the menu', async () => {
		FESTIVALS.splice(
			0,
			1,
			normalizeFestival(
				{
					...DEFAULT_FESTIVALS[0]!,
					description: 'Four days of music.',
					mapUrl: '/data/festivals/tmr26/map.png'
				},
				'2026-01-01'
			)
		);
		await renderPage();

		await fireEvent.click(screen.getAllByRole('button', { name: 'More options' })[0]!);
		for (const label of ['Description and dates', 'Map', 'Share', 'Sign in']) {
			expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
		}

		await fireEvent.click(screen.getByRole('button', { name: 'Description and dates' }));
		expect(await screen.findByText('Four days of music.')).toBeInTheDocument();
		expect(screen.getByText(/July 17–20/)).toBeInTheDocument();
	});

	it('shows the Festival image and its status badge in the description dialog', async () => {
		FESTIVALS.splice(
			0,
			1,
			normalizeFestival(
				{ ...DEFAULT_FESTIVALS[0]!, imageUrl: '/data/festivals/tmr26/cover.png' },
				'2026-01-01'
			)
		);
		await renderPage();

		await openMenuItem('Description and dates');

		const dialog = await screen.findByRole('dialog', { name: 'Tomorrowland 2026 – Week 1' });
		const images = dialog.querySelectorAll('img');
		expect(images).toHaveLength(2); // blurred backdrop and the image itself
		for (const image of images) {
			expect(image).toHaveAttribute('src', '/data/festivals/tmr26/cover.png');
		}
		expect(within(dialog).getByText('Upcoming')).toBeInTheDocument();
	});

	it('drops the image but keeps the badge when the image fails to load', async () => {
		FESTIVALS.splice(
			0,
			1,
			normalizeFestival(
				{ ...DEFAULT_FESTIVALS[0]!, imageUrl: '/data/festivals/tmr26/cover.png' },
				'2026-01-01'
			)
		);
		await renderPage();
		await openMenuItem('Description and dates');
		const dialog = await screen.findByRole('dialog', { name: 'Tomorrowland 2026 – Week 1' });

		await fireEvent.error(dialog.querySelector('img.info-hero-image')!);

		await waitFor(() => expect(dialog.querySelector('img')).toBeNull());
		expect(within(dialog).getByText('Upcoming')).toBeInTheDocument();
	});

	it.each([
		['2026-01-01', 'Upcoming'],
		['2026-07-18', 'Happening now'],
		['2026-12-01', 'Past']
	])('on %s the badge reads %s', async (today, label) => {
		FESTIVALS.splice(0, 1, normalizeFestival(DEFAULT_FESTIVALS[0]!, today));
		await renderPage();

		await openMenuItem('Description and dates');

		const dialog = await screen.findByRole('dialog', { name: 'Tomorrowland 2026 – Week 1' });
		expect(within(dialog).getByText(label)).toBeInTheDocument();
	});

	it('still shows the status badge when the Festival has no image', async () => {
		await renderPage();

		await openMenuItem('Description and dates');

		const dialog = await screen.findByRole('dialog', { name: 'Tomorrowland 2026 – Week 1' });
		expect(dialog.querySelector('img')).toBeNull();
		expect(within(dialog).getByText('Upcoming')).toBeInTheDocument();
	});

	it('opens the map overlay from the menu', async () => {
		// `bind:clientWidth` in the overlay compiles to a ResizeObserver, which jsdom lacks.
		vi.stubGlobal(
			'ResizeObserver',
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			}
		);
		FESTIVALS.splice(
			0,
			1,
			normalizeFestival(
				{ ...DEFAULT_FESTIVALS[0]!, mapUrl: '/data/festivals/tmr26/map.png' },
				'2026-01-01'
			)
		);
		await renderPage();

		await openMenuItem('Map');

		expect(await screen.findByRole('button', { name: 'Close' })).toBeInTheDocument();
	});

	it('My Picks lists only my going and maybe Performances', async () => {
		setSessionUser();
		server.mine = { [PERF_A]: 1, [PERF_B]: 2, [LATE_PERF]: 2 };
		server.publicPicks = { [DAY1_PERF]: [{ handle: 'sam', colour: BLUE, state: 1 }] };
		await renderPage();
		await waitFor(() => expect(within(block(PERF_A)).getByTitle('alex')).toBeInTheDocument());

		await fireEvent.click(screen.getAllByRole('button', { name: /My Picks/ })[0]!);

		expect(await screen.findByText('DISCOVERY')).toBeInTheDocument();
		expect(screen.getByText('DJORA')).toBeInTheDocument();
		expect(screen.queryByText('Synoxis')).toBeNull();
		// Going and maybe both listed, in time order.
		const first = screen.getByText('DISCOVERY');
		const late = screen.getByText(LATE_NAME);
		expect(first.compareDocumentPosition(late) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it('a #perf- link switches Day and highlights the Performance', async () => {
		await renderPage();

		location.hash = `#perf-${DAY1_PERF}`;
		await fireEvent(window, new HashChangeEvent('hashchange'));

		await waitFor(() => expect(document.getElementById(`perf-${DAY1_PERF}`)).not.toBeNull());
		expect(document.getElementById(`perf-${DAY1_PERF}`)!.className).toMatch(/highlight/);
		location.hash = '';
	});
});
