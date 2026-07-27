import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { resetMockPage, setMockPage } from '../test-support/app-state.svelte.js';
import { saveGoogleAuth } from '$lib/stagehopper/storage.js';
import type { RoomSelection } from '$lib/stagehopper/types.js';

const goto = vi.fn();
const fetchMock = vi.fn();

vi.mock('$app/navigation', () => ({ goto: (...args: unknown[]) => goto(...args) }));
vi.mock('$app/environment', () => ({ browser: true, building: false, dev: true }));

vi.mock('$app/state', async () => {
	const { mockPage } = await import('../test-support/app-state.svelte.js');
	return { page: mockPage };
});

const { default: RoomPage } = await import('./[roomId]/+page.svelte');

const VIEWER_ID = 'google:123';

function jsonResponse(body: unknown, status = 200) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function respondWithSelections(selections: RoomSelection[]) {
	fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
		Promise.resolve(init ? jsonResponse({ ok: true }) : jsonResponse(selections))
	);
}

function signIn() {
	saveGoogleAuth({ idToken: 'tok', sub: '123', name: 'Alex Example', givenName: 'Alex' });
}

/** Requests the page made to read a room, by room id. */
function roomsRead(): string[] {
	return fetchMock.mock.calls
		.filter(([, init]) => !init)
		.map(([url]) => String(url).replace('/api/stagehopper/rooms/', '').replace('/selections', ''));
}

beforeEach(() => {
	goto.mockReset();
	fetchMock.mockReset();
	respondWithSelections([]);
	vi.stubGlobal('fetch', fetchMock);
	// The page registers a service worker on mount; jsdom has no support for it.
	vi.stubGlobal('navigator', navigator);
	resetMockPage();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('room route — bootstrapping', () => {
	it('loads the room named by the route', async () => {
		signIn();
		setMockPage({ params: { roomId: 'tmr26-abc123' } });

		render(RoomPage);

		await waitFor(() => expect(roomsRead()).toContain('tmr26-abc123'));
		expect(await screen.findByRole('heading', { name: 'Join the room' })).toBeInTheDocument();
	});

	it('re-bootstraps when the route moves to another room', async () => {
		signIn();
		setMockPage({ params: { roomId: 'tmr26-abc123' } });
		render(RoomPage);
		await waitFor(() => expect(roomsRead()).toContain('tmr26-abc123'));

		setMockPage({ params: { roomId: 'tmr26-def456' } });

		await waitFor(() => expect(roomsRead()).toContain('tmr26-def456'));
	});

	it('does not re-bootstrap when the route reports the same room again', async () => {
		signIn();
		setMockPage({ params: { roomId: 'tmr26-abc123' } });
		render(RoomPage);
		await waitFor(() => expect(roomsRead()).toHaveLength(1));

		setMockPage({ params: { roomId: 'tmr26-abc123' } });
		await Promise.resolve();

		expect(roomsRead()).toHaveLength(1);
	});

	it('sends a signed-out visitor to the landing page with the room remembered', async () => {
		setMockPage({ params: { roomId: 'tmr26-abc123' } });

		render(RoomPage);

		await waitFor(() =>
			expect(goto).toHaveBeenCalledWith(`/?next=${encodeURIComponent('tmr26-abc123')}`)
		);
	});

	it('renders a festival lineup for a guest without asking anything of them', async () => {
		setMockPage({ params: { roomId: 'tmr26' } });

		render(RoomPage);

		expect(await screen.findByTitle('THE GATHERING')).toBeInTheDocument();
		expect(screen.queryByRole('heading', { name: 'Join the room' })).not.toBeInTheDocument();
		expect(goto).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('shows the day tabs for the festival the room belongs to', async () => {
		setMockPage({ params: { roomId: 'ps26' } });

		render(RoomPage);

		expect(await screen.findByRole('button', { name: 'Thursday, June 4' })).toBeInTheDocument();
	});
});

describe('room route — joined room', () => {
	beforeEach(() => {
		signIn();
		respondWithSelections([
			{ userId: VIEWER_ID, name: 'Alex', color: '#e74c3c', selections: {} },
			{ userId: 'google:friend', name: 'Sam', color: '#3498db', selections: {} }
		]);
		setMockPage({ params: { roomId: 'tmr26-abc123' } });
	});

	it('lists the participants once the room loads', async () => {
		render(RoomPage);

		expect(await screen.findByText('Alex (you)')).toBeInTheDocument();
		expect(screen.getByText('Sam')).toBeInTheDocument();
	});

	it('offers the picks and liked views to a member', async () => {
		render(RoomPage);

		await screen.findByText('Alex (you)');
		expect(screen.getAllByRole('button', { name: 'Picks' }).length).toBeGreaterThan(0);
	});

	it('switches to the liked view and back', async () => {
		render(RoomPage);
		await screen.findByText('Alex (you)');

		await fireEvent.click(screen.getAllByRole('button', { name: /Liked/ })[0]!);
		expect(screen.getByText('Open a performance and tap ♥ to save it here.')).toBeInTheDocument();

		await fireEvent.click(screen.getAllByRole('button', { name: /Timetable/ })[0]!);
		expect(screen.getByTitle('THE GATHERING')).toBeInTheDocument();
	});

	it('opens the artist card from a performance and closes it again', async () => {
		render(RoomPage);
		await screen.findByText('Alex (you)');

		await fireEvent.click(screen.getByText('Dino'));
		expect(await screen.findByRole('dialog', { name: 'Dino' })).toBeInTheDocument();

		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		await waitFor(() =>
			expect(screen.queryByRole('dialog', { name: 'Dino' })).not.toBeInTheDocument()
		);
	});
});

describe('room route — teardown', () => {
	it('stops polling and drops its window listeners when the page unmounts', async () => {
		vi.useFakeTimers();
		signIn();
		setMockPage({ params: { roomId: 'tmr26-abc123' } });
		const removeEventListener = vi.spyOn(window, 'removeEventListener');
		const { unmount } = render(RoomPage);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

		unmount();
		fetchMock.mockClear();
		await vi.advanceTimersByTimeAsync(30_000);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(removeEventListener).toHaveBeenCalledWith('pagehide', expect.any(Function));
		removeEventListener.mockRestore();
		vi.useRealTimers();
	});
});
