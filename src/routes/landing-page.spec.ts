import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { resetMockPage, setMockPage } from '../test-support/app-state.svelte.js';
import {
	DEFAULT_FESTIVALS,
	FESTIVALS,
	normalizeFestival
} from '$lib/stagehopper/festivals.svelte.js';
import type { GoogleCredentialResponse } from '$lib/stagehopper/google-identity.js';
import { saveGoogleAuth } from '$lib/stagehopper/storage.js';

const goto = vi.fn();
const checkAdmin = vi.fn();
const createRoom = vi.fn();
const leaveRoom = vi.fn();
const listMyRooms = vi.fn();
/** Captures the callback the page hands to Google, so tests can complete a sign-in. */
let capturedOnCredential: ((response: GoogleCredentialResponse) => void) | null = null;

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

vi.mock('$lib/stagehopper/google-identity.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/stagehopper/google-identity.js')>();
	return {
		...actual,
		getGoogleClientId: () => 'test-client-id',
		initGoogleSignIn: vi.fn(async (options: { onCredential: typeof capturedOnCredential }) => {
			capturedOnCredential = options.onCredential;
			return null;
		})
	};
});

const { default: LandingPage } = await import('./+page.svelte');

/** A token whose payload decodes to a usable identity; the signature is never checked here. */
function fakeIdToken(sub = '123', name = 'Alex Example'): string {
	const payload = btoa(JSON.stringify({ sub, name, given_name: 'Alex' }))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
	return `header.${payload}.signature`;
}

function signIn() {
	saveGoogleAuth({ idToken: fakeIdToken(), sub: '123', name: 'Alex Example', givenName: 'Alex' });
}

/** Complete a Google sign-in through the callback the page registered. */
async function completeGoogleSignIn() {
	await waitFor(() => expect(capturedOnCredential).not.toBeNull());
	capturedOnCredential?.({ credential: fakeIdToken() });
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
	capturedOnCredential = null;
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
		expect(screen.getByRole('heading', { name: 'Sign in to continue' })).toBeInTheDocument();
		expect(createRoom).not.toHaveBeenCalled();

		await completeGoogleSignIn();

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
		expect(screen.getByRole('heading', { name: 'Sign in to continue' })).toBeInTheDocument();
		expect(goto).not.toHaveBeenCalled();

		await completeGoogleSignIn();

		await waitFor(() => expect(goto).toHaveBeenCalledWith('/room/tmr26-abc123'));
	});

	it('reports a credential it cannot decode, without signing anyone in', async () => {
		render(LandingPage);
		await fireEvent.click(screen.getAllByRole('button', { name: 'Create room' })[0]!);
		await waitFor(() => expect(capturedOnCredential).not.toBeNull());

		capturedOnCredential?.({ credential: 'not-a-token' });

		// Shown on the gate and, behind it, in the hero — both read the same error state.
		expect(await screen.findAllByText('Google sign-in failed. Please try again.')).toHaveLength(2);
		expect(localStorage.getItem('stagehopper:auth:idToken')).toBeNull();
		expect(createRoom).not.toHaveBeenCalled();
		expect(screen.getByRole('heading', { name: 'Sign in to continue' })).toBeInTheDocument();
	});

	it('reports a response that carries no credential', async () => {
		render(LandingPage);
		await fireEvent.click(screen.getAllByRole('button', { name: 'Create room' })[0]!);
		await waitFor(() => expect(capturedOnCredential).not.toBeNull());

		capturedOnCredential?.({});

		expect(
			(await screen.findAllByText('Google sign-in failed. Please try again.'))[0]
		).toBeInTheDocument();
		expect(createRoom).not.toHaveBeenCalled();
	});

	it('lets the visitor back out of the sign-in gate', async () => {
		render(LandingPage);
		await fireEvent.click(screen.getAllByRole('button', { name: 'Create room' })[0]!);

		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.queryByRole('heading', { name: 'Sign in to continue' })).not.toBeInTheDocument();
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

	it('forgets the identity on sign-out', async () => {
		render(LandingPage);
		await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument());

		await fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

		expect(localStorage.getItem('stagehopper:auth:idToken')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
	});

	it('creates a room without a sign-in gate', async () => {
		render(LandingPage);

		await fireEvent.click(screen.getAllByRole('button', { name: 'Create room' })[0]!);

		expect(screen.queryByRole('heading', { name: 'Sign in to continue' })).not.toBeInTheDocument();
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
});

describe('landing page — the admin link', () => {
	beforeEach(signIn);

	it('offers the admin console to an admin', async () => {
		checkAdmin.mockResolvedValue(true);
		render(LandingPage);

		const link = await screen.findByRole('link', { name: 'Admin' });
		expect(link).toHaveAttribute('href', '/admin');
		expect(checkAdmin).toHaveBeenCalledWith(fakeIdToken());
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
		localStorage.clear();
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
		await completeGoogleSignIn();

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

		await waitFor(() => expect(screen.getByText('Your rooms')).toBeInTheDocument());
		expect(yourRooms().getByText(/Tomorrowland 2026 – Week 1/)).toBeInTheDocument();
		expect(yourRooms().getByText(/Primavera/)).toBeInTheDocument();
		expect(listMyRooms).toHaveBeenCalledWith(expect.stringContaining('header.'));
	});

	it('marks rooms for festivals that have already happened', async () => {
		render(LandingPage);

		await waitFor(() => expect(screen.getByText('(Past)')).toBeInTheDocument());
	});

	it('opens a room when its row is clicked', async () => {
		render(LandingPage);
		await waitFor(() => expect(screen.getByText('Your rooms')).toBeInTheDocument());

		await fireEvent.click(yourRooms().getByText(/Tomorrowland 2026 – Week 1/));

		expect(goto).toHaveBeenCalledWith('/room/tmr26-abc123');
	});

	it('confirms before leaving, then drops the room from the list', async () => {
		render(LandingPage);
		await waitFor(() => expect(screen.getByText('Your rooms')).toBeInTheDocument());

		await fireEvent.click(screen.getByRole('button', { name: /^Leave Tomorrowland/ }));
		expect(screen.getByRole('heading', { name: 'Leave this room?' })).toBeInTheDocument();
		expect(leaveRoom).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));

		await waitFor(() =>
			expect(yourRooms().queryByText(/Tomorrowland 2026 – Week 1/)).not.toBeInTheDocument()
		);
		expect(leaveRoom).toHaveBeenCalledWith('tmr26-abc123', expect.stringContaining('header.'));
		expect(yourRooms().getByText(/Primavera/)).toBeInTheDocument();
	});

	it('keeps the room when leaving is cancelled', async () => {
		render(LandingPage);
		await waitFor(() => expect(screen.getByText('Your rooms')).toBeInTheDocument());
		await fireEvent.click(screen.getByRole('button', { name: /^Leave Tomorrowland/ }));

		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.queryByRole('heading', { name: 'Leave this room?' })).not.toBeInTheDocument();
		expect(leaveRoom).not.toHaveBeenCalled();
	});

	it('keeps the dialog open and explains a failure to leave', async () => {
		leaveRoom.mockResolvedValue({ ok: false, unauthorized: false, status: 500 });
		render(LandingPage);
		await waitFor(() => expect(screen.getByText('Your rooms')).toBeInTheDocument());
		await fireEvent.click(screen.getByRole('button', { name: /^Leave Tomorrowland/ }));

		await fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));

		await waitFor(() =>
			expect(screen.getByText('Could not leave the room. Please try again.')).toBeInTheDocument()
		);
		expect(yourRooms().getByText(/Tomorrowland 2026 – Week 1/)).toBeInTheDocument();
	});

	it('survives a failure to load the room list', async () => {
		listMyRooms.mockResolvedValue({ ok: false, unauthorized: false, status: 500 });
		render(LandingPage);

		await waitFor(() => expect(screen.getByText('Festivals')).toBeInTheDocument());
		expect(screen.queryByText('Your rooms')).not.toBeInTheDocument();
	});
});
