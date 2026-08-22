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
const createRoom = vi.fn();
const leaveRoom = vi.fn();
const listMyRooms = vi.fn();

vi.mock('$app/navigation', () => ({ goto: (...args: unknown[]) => goto(...args) }));

vi.mock('$app/state', async () => {
	const { mockPage } = await import('../test-support/app-state.svelte.js');
	return { page: mockPage };
});

vi.mock('$lib/stagehopper/api.js', () => ({
	checkAdmin: (...args: unknown[]) => checkAdmin(...args),
	createRoom: (...args: unknown[]) => createRoom(...args),
	leaveRoom: (...args: unknown[]) => leaveRoom(...args),
	listMyRooms: (...args: unknown[]) => listMyRooms(...args)
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

/**
 * Festival names appear both on their card and on any joined-room row, so room-list
 * assertions are scoped to the "Your rooms" section.
 */
function yourRooms() {
	const section = screen.getByRole('heading', { name: 'Your rooms' }).closest('section');
	if (!section) throw new Error('the "Your rooms" section is not rendered');
	return within(section);
}

/** The room id is generated client-side, so only its shape is predictable. */
const ROOM_PATH = /^\/room\/tmr26-[0-9a-f]{6}$/;

beforeEach(() => {
	goto.mockReset();
	checkAdmin.mockReset().mockResolvedValue(false);
	createRoom.mockReset().mockResolvedValue({ ok: true, data: { roomId: 'tmr26-abc123' } });
	leaveRoom.mockReset().mockResolvedValue({ ok: true, data: { ok: true } });
	listMyRooms.mockReset().mockResolvedValue({ ok: true, data: [] });
	resetSession();
	resetMockPage();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('landing page — signed out', () => {
	it('lists every festival with browse and create actions', () => {
		render(LandingPage);

		expect(screen.getByText('Tomorrowland 2026 – Week 1')).toBeInTheDocument();
		expect(screen.getByText('Primavera Sound Barcelona 2026')).toBeInTheDocument();
		expect(screen.getAllByRole('link', { name: 'Browse' })).toHaveLength(2);
		expect(screen.getAllByRole('button', { name: 'Create room' })).toHaveLength(2);
	});

	it('links Browse straight to the festival lineup', () => {
		render(LandingPage);

		expect(screen.getAllByRole('link', { name: 'Browse' })[0]).toHaveAttribute('href', '/room/tmr26');
	});

	it('does not load rooms for a visitor who is not signed in', () => {
		render(LandingPage);

		expect(listMyRooms).not.toHaveBeenCalled();
	});

	it('gates room creation behind sign-in, then creates once signed in', async () => {
		render(LandingPage);

		await fireEvent.click(screen.getAllByRole('button', { name: 'Create room' })[0]!);
		expect(screen.getByRole('dialog', { name: 'Sign in to continue' })).toBeInTheDocument();
		expect(createRoom).not.toHaveBeenCalled();

		await completeSignIn();

		await waitFor(() => expect(createRoom).toHaveBeenCalledOnce());
		expect(createRoom.mock.calls[0]?.[0]).toMatch(/^tmr26-[0-9a-f]{6}$/);
		await waitFor(() => expect(goto).toHaveBeenCalledWith(expect.stringMatching(ROOM_PATH)));
	});

	it('gates joining behind sign-in, then navigates to the parsed room', async () => {
		render(LandingPage);
		await fireEvent.input(screen.getByPlaceholderText('Room code, link, or name'), {
			target: { value: 'abc123' }
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Join' }));
		expect(screen.getByRole('dialog', { name: 'Sign in to continue' })).toBeInTheDocument();
		expect(goto).not.toHaveBeenCalled();

		await completeSignIn();

		await waitFor(() => expect(goto).toHaveBeenCalledWith('/room/tmr26-abc123'));
	});

	it('lets the visitor back out of the sign-in gate', async () => {
		render(LandingPage);
		await fireEvent.click(screen.getAllByRole('button', { name: 'Create room' })[0]!);

		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));

		expect(screen.queryByRole('dialog', { name: 'Sign in to continue' })).not.toBeInTheDocument();
		expect(createRoom).not.toHaveBeenCalled();
	});
});

describe('landing page — joining by code', () => {
	beforeEach(signIn);

	it('keeps the Join button disabled until something is typed', async () => {
		render(LandingPage);
		const join = screen.getByRole('button', { name: 'Join' });

		expect(join).toBeDisabled();

		await fireEvent.input(screen.getByPlaceholderText('Room code, link, or name'), {
			target: { value: 'abc123' }
		});
		expect(join).toBeEnabled();
	});

	it('accepts a full room url', async () => {
		render(LandingPage);
		await fireEvent.input(screen.getByPlaceholderText('Room code, link, or name'), {
			target: { value: 'https://stagehopper.radomskyi.com/tmr26-abc123' }
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Join' }));

		expect(goto).toHaveBeenCalledWith('/room/tmr26-abc123');
	});

	it('joins on Enter', async () => {
		render(LandingPage);
		const input = screen.getByPlaceholderText('Room code, link, or name');
		await fireEvent.input(input, { target: { value: 'birthday party' } });

		await fireEvent.keyDown(input, { key: 'Enter' });

		expect(goto).toHaveBeenCalledWith('/room/birthday-party');
	});

	it('explains input that cannot be turned into a room', async () => {
		render(LandingPage);
		await fireEvent.input(screen.getByPlaceholderText('Room code, link, or name'), {
			target: { value: '!!' }
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Join' }));

		expect(screen.getByText('Enter a room code, link, or name.')).toBeInTheDocument();
		expect(goto).not.toHaveBeenCalled();
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

	it('creates a room without a sign-in gate', async () => {
		render(LandingPage);

		await fireEvent.click(screen.getAllByRole('button', { name: 'Create room' })[0]!);

		expect(screen.queryByRole('dialog', { name: 'Sign in to continue' })).not.toBeInTheDocument();
		await waitFor(() => expect(goto).toHaveBeenCalledWith(expect.stringMatching(ROOM_PATH)));
	});

	it('reports a failure to create a room and re-enables the buttons', async () => {
		createRoom.mockResolvedValue({ ok: false, unauthorized: false, status: 500 });
		render(LandingPage);

		await fireEvent.click(screen.getAllByRole('button', { name: 'Create room' })[0]!);

		await waitFor(() =>
			expect(screen.getByText('Could not create room. Please try again.')).toBeInTheDocument()
		);
		expect(goto).not.toHaveBeenCalled();
		expect(screen.getAllByRole('button', { name: 'Create room' })[0]!).toBeEnabled();
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

describe('landing page — the ?next redirect', () => {
	it('sends a signed-in visitor straight to the room they were invited to', async () => {
		signIn();
		setMockPage({ url: 'http://localhost/?next=tmr26-abc123' });
		render(LandingPage);

		await waitFor(() =>
			expect(goto).toHaveBeenCalledWith('/room/tmr26-abc123', { replaceState: true })
		);
		expect(listMyRooms).not.toHaveBeenCalled();
	});

	it('parses a bare code in ?next', async () => {
		signIn();
		setMockPage({ url: 'http://localhost/?next=abc123' });
		render(LandingPage);

		await waitFor(() =>
			expect(goto).toHaveBeenCalledWith('/room/tmr26-abc123', { replaceState: true })
		);
	});

	it('leaves a signed-out visitor on the landing page', async () => {
		setMockPage({ url: 'http://localhost/?next=tmr26-abc123' });
		render(LandingPage);

		await waitFor(() => expect(screen.getByText('Festivals')).toBeInTheDocument());
		expect(goto).not.toHaveBeenCalled();
	});

	it('redirects once the visitor signs in from the header', async () => {
		setMockPage({ url: 'http://localhost/?next=tmr26-abc123' });
		render(LandingPage);

		// The header "Log in" opens the sign-in modal; no pending action means signing in
		// should honour ?next rather than load rooms.
		await fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
		await completeSignIn();

		await waitFor(() =>
			expect(goto).toHaveBeenCalledWith('/room/tmr26-abc123', { replaceState: true })
		);
	});
});

describe('landing page — your rooms', () => {
	const rooms = [
		{ roomId: 'tmr26-abc123', name: 'Alex', color: '#e74c3c', updatedAt: 20 },
		{ roomId: 'ps26-def456', name: 'Alex', color: '#3498db', updatedAt: 10 }
	];

	/**
	 * Whether tmr26/ps26 are past depends on the real date, which will keep drifting past
	 * their seeded dates — so "today" is fixed between the two rather than reading the
	 * live default list, which stops making one of them past sometime in mid-2026.
	 */
	const ORIGINAL_FESTIVALS = [...FESTIVALS];

	beforeEach(() => {
		signIn();
		listMyRooms.mockResolvedValue({ ok: true, data: rooms });
		FESTIVALS.splice(
			0,
			FESTIVALS.length,
			...DEFAULT_FESTIVALS.map((r) => normalizeFestival(r, '2026-07-01'))
		);
	});

	afterEach(() => {
		FESTIVALS.splice(0, FESTIVALS.length, ...ORIGINAL_FESTIVALS);
	});

	it('lists the rooms this identity has joined', async () => {
		render(LandingPage);

		await waitFor(() =>
			expect(yourRooms().getByText(/Tomorrowland 2026 – Week 1/)).toBeInTheDocument()
		);
		expect(yourRooms().getByText(/Primavera/)).toBeInTheDocument();
		expect(listMyRooms).toHaveBeenCalled();
	});

	it('marks rooms for festivals that have already happened', async () => {
		render(LandingPage);

		await waitFor(() => expect(screen.getByText('(Past)')).toBeInTheDocument());
	});

	it('opens a room when its row is clicked', async () => {
		render(LandingPage);
		await waitFor(() =>
			expect(yourRooms().getByText(/Tomorrowland 2026 – Week 1/)).toBeInTheDocument()
		);

		await fireEvent.click(yourRooms().getByText(/Tomorrowland 2026 – Week 1/));

		expect(goto).toHaveBeenCalledWith('/room/tmr26-abc123');
	});

	it('confirms before leaving, then drops the room from the list', async () => {
		render(LandingPage);
		await waitFor(() =>
			expect(screen.getByRole('button', { name: /^Leave Tomorrowland/ })).toBeInTheDocument()
		);

		await fireEvent.click(screen.getByRole('button', { name: /^Leave Tomorrowland/ }));
		expect(screen.getByRole('heading', { name: 'Leave this room?' })).toBeInTheDocument();
		expect(leaveRoom).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));

		await waitFor(() =>
			expect(yourRooms().queryByText(/Tomorrowland 2026 – Week 1/)).not.toBeInTheDocument()
		);
		expect(leaveRoom).toHaveBeenCalledWith('tmr26-abc123');
		expect(yourRooms().getByText(/Primavera/)).toBeInTheDocument();
	});

	it('keeps the room when leaving is cancelled', async () => {
		render(LandingPage);
		await waitFor(() =>
			expect(screen.getByRole('button', { name: /^Leave Tomorrowland/ })).toBeInTheDocument()
		);
		await fireEvent.click(screen.getByRole('button', { name: /^Leave Tomorrowland/ }));

		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.queryByRole('heading', { name: 'Leave this room?' })).not.toBeInTheDocument();
		expect(leaveRoom).not.toHaveBeenCalled();
	});

	it('keeps the dialog open and explains a failure to leave', async () => {
		leaveRoom.mockResolvedValue({ ok: false, unauthorized: false, status: 500 });
		render(LandingPage);
		await waitFor(() =>
			expect(screen.getByRole('button', { name: /^Leave Tomorrowland/ })).toBeInTheDocument()
		);
		await fireEvent.click(screen.getByRole('button', { name: /^Leave Tomorrowland/ }));

		await fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));

		await waitFor(() =>
			expect(screen.getByText('Could not leave the room. Please try again.')).toBeInTheDocument()
		);
		expect(yourRooms().getByText(/Tomorrowland 2026 – Week 1/)).toBeInTheDocument();
	});

	it('survives a failure to load the room list, degrading to the empty state', async () => {
		listMyRooms.mockResolvedValue({ ok: false, unauthorized: false, status: 500 });
		render(LandingPage);

		await waitFor(() => expect(screen.getByText('Festivals')).toBeInTheDocument());
		// Signed in, so the section still shows; a failed load leaves it empty.
		expect(screen.getByRole('heading', { name: 'Your rooms' })).toBeInTheDocument();
		await waitFor(() => expect(screen.getByText('You have no rooms yet.')).toBeInTheDocument());
	});

	it('shows the empty state when a signed-in user has no rooms', async () => {
		listMyRooms.mockResolvedValue({ ok: true, data: [] });
		render(LandingPage);

		await waitFor(() => expect(screen.getByText('You have no rooms yet.')).toBeInTheDocument());
		expect(screen.getByRole('heading', { name: 'Your rooms' })).toBeInTheDocument();
	});

	it('shows a spinner while the room list is loading', async () => {
		let resolveList!: (v: { ok: true; data: typeof rooms }) => void;
		listMyRooms.mockReturnValue(new Promise((r) => (resolveList = r)));
		const { container } = render(LandingPage);

		// Header is up immediately; the list is still loading.
		expect(screen.getByRole('heading', { name: 'Your rooms' })).toBeInTheDocument();
		await waitFor(() => expect(container.querySelector('.spinner')).toBeInTheDocument());
		expect(screen.queryByText('You have no rooms yet.')).not.toBeInTheDocument();

		resolveList({ ok: true, data: rooms });
		await waitFor(() => expect(container.querySelector('.spinner')).not.toBeInTheDocument());
		expect(yourRooms().getByText(/Tomorrowland 2026 – Week 1/)).toBeInTheDocument();
	});
});
