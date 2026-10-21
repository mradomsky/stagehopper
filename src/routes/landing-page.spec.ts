import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { resetMockPage, setMockPage } from '../test-support/app-state.svelte.js';
import {
	DEFAULT_FESTIVALS,
	FESTIVALS,
	normalizeFestival
} from '$lib/stagehopper/festivals.svelte.js';
import {
	resetSession,
	session,
	setSessionPending,
	setSessionUser
} from '../test-support/auth-session.svelte.js';

const goto = vi.fn();
const checkAdmin = vi.fn();
const fetchFestivalSummary = vi.fn();

vi.mock('$app/navigation', () => ({ goto: (...args: unknown[]) => goto(...args) }));

vi.mock('$app/state', async () => {
	const { mockPage } = await import('../test-support/app-state.svelte.js');
	return { page: mockPage };
});

vi.mock('$lib/stagehopper/api.js', () => ({
	checkAdmin: (...args: unknown[]) => checkAdmin(...args),
	fetchFestivalSummary: (...args: unknown[]) => fetchFestivalSummary(...args)
}));

// Clerk's prebuilt component owns the sign-in flow, so nothing here fakes a credential.
// A test signs someone in by setting the session; the page notices the same way it does in
// a browser — by watching `auth.user`.
vi.mock('$lib/stagehopper/auth.svelte.js', async () => {
	const { mockAuthModule } = await import('../test-support/auth-session.svelte.js');
	return mockAuthModule();
});

const { default: LandingPage } = await import('./+page.svelte');

function signIn() {
	setSessionUser();
}

/**
 * Finish a sign-in the way Clerk does: the session appears, and the page's effect on
 * `auth.user` picks it up. There is no callback to invoke and no credential to hand over.
 */
async function completeSignIn() {
	signIn();
	await waitFor(() => expect(session.user).not.toBeNull());
}

beforeEach(() => {
	goto.mockReset();
	checkAdmin.mockReset().mockResolvedValue(false);
	fetchFestivalSummary
		.mockReset()
		.mockResolvedValue({ ok: true, data: { attendees: 0, latestMessage: null } });
	resetSession();
	resetMockPage();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('landing page — signed out', () => {
	it('lists every festival, each linking to its detail page', () => {
		render(LandingPage);

		expect(screen.getByText('Tomorrowland 2026 – Week 1')).toBeInTheDocument();
		expect(screen.getByText('Primavera Sound Barcelona 2026')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: /Tomorrowland 2026/ })).toHaveAttribute(
			'href',
			'/festival/tmr26'
		);
		expect(screen.getByRole('link', { name: /Primavera Sound/ })).toHaveAttribute(
			'href',
			'/festival/ps26'
		);
	});

});

describe('landing page — sign-in redirect', () => {
	it.each([
		['signed out', false],
		['signed in', true]
	])('ignores ?next=/festival/x when %s', async (_name, signedIn) => {
		if (signedIn) signIn();
		setMockPage({ url: 'http://localhost/?next=/festival/x' });
		render(LandingPage);

		await waitFor(() => expect(screen.getByText('Festivals')).toBeInTheDocument());
		expect(goto).not.toHaveBeenCalled();
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});

	it('still lets a visitor log in from the header, and back out', async () => {
		render(LandingPage);

		await fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
		expect(screen.getByRole('dialog', { name: 'Sign in to continue' })).toBeInTheDocument();

		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(screen.queryByRole('dialog', { name: 'Sign in to continue' })).not.toBeInTheDocument();
	});
});

describe('landing page — festival summaries', () => {
	const originalFestivals = [...FESTIVALS];

	afterEach(() => {
		FESTIVALS.splice(0, FESTIVALS.length, ...originalFestivals);
	});

	const summaries: Record<string, unknown> = {
		tmr26: {
			ok: true,
			data: { attendees: 12, latestMessage: { handle: 'ana', text: 'see you there' } }
		},
		ps26: { ok: true, data: { attendees: 1, latestMessage: null } }
	};

	function card(name: RegExp) {
		return within(screen.getByRole('link', { name }));
	}

	it('shows each listed card its Attendee count and latest Message', async () => {
		fetchFestivalSummary.mockImplementation(async (id: string) => summaries[id]);
		render(LandingPage);

		await waitFor(() => expect(card(/Tomorrowland/).getByText('12 attending')).toBeInTheDocument());
		expect(card(/Tomorrowland/).getByText('ana: see you there')).toBeInTheDocument();
		expect(card(/Primavera/).getByText('1 attending')).toBeInTheDocument();
		expect(card(/Primavera/).queryByText(/:/)).not.toBeInTheDocument();
		expect(fetchFestivalSummary).toHaveBeenCalledWith('tmr26');
		expect(fetchFestivalSummary).toHaveBeenCalledWith('ps26');
	});

	it('leaves a zero-state card bare', async () => {
		render(LandingPage);

		await waitFor(() => expect(fetchFestivalSummary).toHaveBeenCalledTimes(2));
		expect(screen.queryByText(/attending/)).not.toBeInTheDocument();
	});

	it('leaves only the failed card bare, with no error UI', async () => {
		fetchFestivalSummary.mockImplementation(async (id: string) =>
			id === 'tmr26' ? { ok: false, unauthorized: false, status: 200 } : summaries[id]
		);
		render(LandingPage);

		await waitFor(() => expect(card(/Primavera/).getByText('1 attending')).toBeInTheDocument());
		expect(card(/Tomorrowland/).queryByText(/attending/)).not.toBeInTheDocument();
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		expect(screen.getByText('Tomorrowland 2026 – Week 1')).toBeInTheDocument();
	});

	it('survives a rejected request', async () => {
		fetchFestivalSummary.mockImplementation(async (id: string) => {
			if (id === 'tmr26') throw new Error('network');
			return summaries[id];
		});
		render(LandingPage);

		await waitFor(() => expect(card(/Primavera/).getByText('1 attending')).toBeInTheDocument());
		expect(card(/Tomorrowland/).queryByText(/attending/)).not.toBeInTheDocument();
	});

	it('renders each card as its own summary arrives', async () => {
		let resolveSlow!: (v: unknown) => void;
		fetchFestivalSummary.mockImplementation((id: string) =>
			id === 'tmr26' ? new Promise((r) => (resolveSlow = r)) : Promise.resolve(summaries[id])
		);
		render(LandingPage);

		await waitFor(() => expect(card(/Primavera/).getByText('1 attending')).toBeInTheDocument());
		expect(card(/Tomorrowland/).queryByText(/attending/)).not.toBeInTheDocument();

		resolveSlow(summaries.tmr26);
		await waitFor(() => expect(card(/Tomorrowland/).getByText('12 attending')).toBeInTheDocument());
	});

	it('requests nothing for an unlisted Festival', async () => {
		FESTIVALS.splice(
			0,
			FESTIVALS.length,
			...DEFAULT_FESTIVALS.map((r) =>
				normalizeFestival(r.id === 'ps26' ? { ...r, isListedOnLanding: false } : r)
			)
		);
		render(LandingPage);

		await waitFor(() => expect(fetchFestivalSummary).toHaveBeenCalledWith('tmr26'));
		expect(fetchFestivalSummary).not.toHaveBeenCalledWith('ps26');
	});

	it('fetches the same summaries and shows the same cards signed in', async () => {
		fetchFestivalSummary.mockImplementation(async (id: string) => summaries[id]);
		signIn();
		render(LandingPage);

		await waitFor(() => expect(card(/Tomorrowland/).getByText('12 attending')).toBeInTheDocument());
		expect(fetchFestivalSummary).toHaveBeenCalledTimes(2);
		// Public read: the page passes the Festival id and nothing else.
		expect(fetchFestivalSummary.mock.calls.every((c) => c.length === 1)).toBe(true);
	});

	it('renders the same empty Festivals section when every Festival is unlisted (#195)', () => {
		FESTIVALS.splice(
			0,
			FESTIVALS.length,
			...DEFAULT_FESTIVALS.map((r) => normalizeFestival({ ...r, isListedOnLanding: false }))
		);
		const { container } = render(LandingPage);

		expect(screen.getByRole('heading', { name: 'Festivals' })).toBeInTheDocument();
		expect(container.querySelector('.festival-grid')?.children).toHaveLength(0);
		expect(fetchFestivalSummary).not.toHaveBeenCalled();
	});
});

describe('landing page — unlisted festivals', () => {
	const originalFestivals = [...FESTIVALS];

	afterEach(() => {
		FESTIVALS.splice(0, FESTIVALS.length, ...originalFestivals);
	});

	it('shows no card for a festival with isListedOnLanding false', () => {
		FESTIVALS.splice(
			0,
			FESTIVALS.length,
			...DEFAULT_FESTIVALS.map((r) =>
				normalizeFestival(r.id === 'ps26' ? { ...r, isListedOnLanding: false } : r)
			)
		);
		render(LandingPage);

		expect(screen.getByText('Tomorrowland 2026 – Week 1')).toBeInTheDocument();
		expect(screen.queryByText('Primavera Sound Barcelona 2026')).not.toBeInTheDocument();
	});

	it('still shows a festival whose record has no isListedOnLanding field', () => {
		FESTIVALS.splice(0, FESTIVALS.length, ...DEFAULT_FESTIVALS.map((r) => normalizeFestival(r)));
		render(LandingPage);

		expect(screen.getByText('Primavera Sound Barcelona 2026')).toBeInTheDocument();
	});
});

describe('landing page — signed in', () => {
	beforeEach(signIn);

	it('greets the signed-in user and offers sign-out', async () => {
		render(LandingPage);

		await waitFor(() => expect(screen.getByText(/Alex Example/)).toBeInTheDocument());
		expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
	});

	// `undefined` is "Clerk has not answered yet" and is what keeps the header quiet. The
	// flash this prevents — a name rendered and then retracted — is #96.
	it('shows a checking indicator, not a name, until Clerk resolves the session', async () => {
		setSessionPending();
		render(LandingPage);

		expect(screen.queryByText(/Alex Example/)).not.toBeInTheDocument();
		expect(screen.getByRole('status', { name: 'Checking sign-in' })).toBeInTheDocument();

		setSessionUser();
		await waitFor(() => expect(screen.getByText(/Alex Example/)).toBeInTheDocument());
		expect(screen.queryByRole('status', { name: 'Checking sign-in' })).not.toBeInTheDocument();
	});

	it('drops to the guest view without ever flashing a name when there is no session', async () => {
		setSessionPending();
		render(LandingPage);

		resetSession();
		await waitFor(() => expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument());
		expect(screen.queryByText(/Alex Example/)).not.toBeInTheDocument();
	});

	it('forgets the identity on sign-out', async () => {
		render(LandingPage);
		await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument());

		await fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

		await waitFor(() => expect(session.user).toBeNull());
		expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
	});
	describe('festival badges', () => {
		const originalFestivals = [...FESTIVALS];

		beforeEach(signIn);

		afterEach(() => {
			FESTIVALS.splice(0, FESTIVALS.length, ...originalFestivals);
		});

		it('shows Happening now badge for festivals currently happening', () => {
			FESTIVALS.splice(
				0,
				FESTIVALS.length,
				...DEFAULT_FESTIVALS.map((r) => normalizeFestival(r, '2026-07-18'))
			);
			render(LandingPage);

			expect(screen.getByText('Happening now')).toBeInTheDocument();
			expect(screen.queryAllByText('Upcoming')).toHaveLength(0);
		});

		it('shows Upcoming badge for festivals not yet started', () => {
			FESTIVALS.splice(
				0,
				FESTIVALS.length,
				...DEFAULT_FESTIVALS.map((r) => normalizeFestival(r, '2026-01-01'))
			);
			render(LandingPage);

			expect(screen.getAllByText('Upcoming')).toHaveLength(2);
		});
	});
});

describe('landing page — the admin link', () => {
	beforeEach(signIn);

	it('offers the admin console to an admin', async () => {
		checkAdmin.mockResolvedValue(true);
		render(LandingPage);

		const link = await screen.findByRole('link', { name: 'Admin' });
		expect(link).toHaveAttribute('href', '/admin');
		expect(checkAdmin).toHaveBeenCalled();
	});

	it('hides it from an ordinary signed-in user', async () => {
		render(LandingPage);

		await waitFor(() => expect(checkAdmin).toHaveBeenCalled());
		expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
	});

	it('withdraws it on sign-out', async () => {
		checkAdmin.mockResolvedValue(true);
		render(LandingPage);
		await screen.findByRole('link', { name: 'Admin' });

		await fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

		expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
	});

	it('asks nothing of the server for a signed-out visitor', async () => {
		resetSession();
		render(LandingPage);

		await waitFor(() => expect(screen.getByText(/Plan your festival days/)).toBeInTheDocument());
		expect(checkAdmin).not.toHaveBeenCalled();
	});
});
