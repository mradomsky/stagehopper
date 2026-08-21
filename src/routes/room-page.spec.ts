import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { resetMockPage, setMockPage } from '../test-support/app-state.svelte.js';
import { saveGoogleAuth } from '$lib/stagehopper/storage.js';
import type { RoomSelection } from '$lib/stagehopper/types.js';
import tmr26Timetable from '../test-support/fixtures/timetable-tmr26.json';
import ps26Timetable from '../test-support/fixtures/timetable-ps26.json';

const goto = vi.fn();
const fetchMock = vi.fn();

vi.mock('$app/navigation', () => ({ goto: (...args: unknown[]) => goto(...args) }));
vi.mock('$app/environment', () => ({ browser: true, building: false, dev: true }));

vi.mock('$app/state', async () => {
	const { mockPage } = await import('../test-support/app-state.svelte.js');
	return { page: mockPage };
});

const { default: RoomPage } = await import('./room/[roomId]/+page.svelte');

const VIEWER_ID = 'google:123';

function jsonResponse(body: unknown, status = 200) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function timetableResponseFor(url: string) {
	if (url.includes('timetable-tmr26')) return jsonResponse(tmr26Timetable);
	if (url.includes('timetable-ps26')) return jsonResponse(ps26Timetable);
	return jsonResponse({ formatVersion: 1, festivalId: 'unknown', days: [] }, 404);
}

/**
 * Both the room-selections GET and the timetable GET are bodyless (`init` is
 * undefined), so this routes by URL rather than by presence of `init`.
 */
function respondWithSelections(selections: RoomSelection[]) {
	fetchMock.mockImplementation((url: string, init?: RequestInit) => {
		if (typeof url === 'string' && url.startsWith('/data/timetable-')) {
			return Promise.resolve(timetableResponseFor(url));
		}
		return Promise.resolve(init ? jsonResponse({ ok: true }) : jsonResponse(selections));
	});
}

function signIn() {
	saveGoogleAuth({ idToken: 'tok', sub: '123', name: 'Alex Example', givenName: 'Alex' });
}

/** Requests the page made to read a room's selections, by room id — excludes the
 * separate timetable fetch bootstrap also makes. */
function roomsRead(): string[] {
	return fetchMock.mock.calls
		.filter(([url, init]) => !init && !String(url).startsWith('/data/timetable-'))
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

	it('catches up on picks when the tab comes back to the foreground', async () => {
		signIn();
		setMockPage({ params: { roomId: 'tmr26-abc123' } });
		render(RoomPage);
		await waitFor(() => expect(roomsRead()).toContain('tmr26-abc123'));
		fetchMock.mockClear();

		// Polling pauses while hidden, so without a catch-up read the viewer would stare
		// at stale picks for up to a full poll interval on returning.
		await fireEvent(document, new Event('visibilitychange'));

		await waitFor(() => expect(roomsRead()).toContain('tmr26-abc123'));
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
		// The timetable is a public read either way; guest browsing just never hits the
		// selections API, since there's no room membership to read.
		expect(roomsRead()).toEqual([]);
	});

	it('shows the day tabs for the festival the room belongs to', async () => {
		setMockPage({ params: { roomId: 'ps26' } });

		render(RoomPage);

		expect(await screen.findByRole('button', { name: 'Thursday, June 4' })).toBeInTheDocument();
	});
});

describe('room route — timetable loading', () => {
	it('shows a loading state before the timetable arrives', async () => {
		let resolveTimetable!: (value: unknown) => void;
		fetchMock.mockImplementation((url: string, init?: RequestInit) => {
			if (typeof url === 'string' && url.startsWith('/data/timetable-')) {
				return new Promise((resolve) => (resolveTimetable = resolve));
			}
			return Promise.resolve(init ? jsonResponse({ ok: true }) : jsonResponse([]));
		});
		setMockPage({ params: { roomId: 'tmr26' } });

		render(RoomPage);

		expect(await screen.findByText('Loading the timetable…')).toBeInTheDocument();
		expect(screen.queryByTitle('THE GATHERING')).not.toBeInTheDocument();

		resolveTimetable(jsonResponse(tmr26Timetable));
		await waitFor(() => expect(screen.queryByText('Loading the timetable…')).not.toBeInTheDocument());
	});

	it('shows a retry affordance when the fetch fails, and recovers on retry', async () => {
		fetchMock.mockImplementation((url: string, init?: RequestInit) => {
			if (typeof url === 'string' && url.startsWith('/data/timetable-')) {
				return Promise.resolve(jsonResponse({}, 500));
			}
			return Promise.resolve(init ? jsonResponse({ ok: true }) : jsonResponse([]));
		});
		setMockPage({ params: { roomId: 'tmr26' } });

		render(RoomPage);

		expect(
			await screen.findByText('Could not load the timetable. Please try again.')
		).toBeInTheDocument();

		respondWithSelections([]);
		await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

		expect(await screen.findByTitle('THE GATHERING')).toBeInTheDocument();
		expect(
			screen.queryByText('Could not load the timetable. Please try again.')
		).not.toBeInTheDocument();
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

	it('offers the picks-only eye, the Picks tab, and Liked in the menu to a member', async () => {
		render(RoomPage);

		await screen.findByText('Alex (you)');
		expect(screen.getByRole('button', { name: 'Show only my picks' })).toBeInTheDocument();
		expect(screen.getAllByRole('button', { name: /My Picks/ }).length).toBeGreaterThan(0);

		await fireEvent.click(screen.getAllByRole('button', { name: 'More options' })[0]!);
		expect(screen.getByRole('button', { name: 'Liked' })).toBeInTheDocument();
	});

	it('filters the grid to picks when the eye is toggled', async () => {
		render(RoomPage);
		await screen.findByText('Alex (you)');

		await fireEvent.click(screen.getByRole('button', { name: 'Show only my picks' }));

		// With nothing marked yet, the picks-only grid explains how to fill it.
		expect(screen.getByText(/after you mark performances/i)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Show all performances' })).toBeInTheDocument();
	});

	it('switches to the Picks tab and back', async () => {
		render(RoomPage);
		await screen.findByText('Alex (you)');

		await fireEvent.click(screen.getAllByRole('button', { name: /My Picks/ })[0]!);
		expect(screen.getByText('No picks yet — tap ★ on a set to add it here.')).toBeInTheDocument();

		await fireEvent.click(screen.getAllByRole('button', { name: /Timetable/ })[0]!);
		expect(screen.getByTitle('THE GATHERING')).toBeInTheDocument();
	});

	it('lists a marked set on the Picks tab, and opens its details card from there', async () => {
		render(RoomPage);
		await screen.findByText('Alex (you)');

		const dinoBlock = screen.getByText('Dino').closest('[role="button"]') as HTMLElement;
		await fireEvent.pointerUp(within(dinoBlock).getByRole('button', { name: 'Mark as going' }));

		await fireEvent.click(screen.getAllByRole('button', { name: /My Picks/ })[0]!);
		expect(screen.getByText('Dino')).toBeInTheDocument();
		expect(screen.getByText('13:00–14:00')).toBeInTheDocument();
		expect(screen.getByText('THE GATHERING')).toBeInTheDocument();
		expect(screen.getByText('attending')).toBeInTheDocument();

		await fireEvent.click(screen.getByText('Dino'));
		expect(await screen.findByRole('dialog', { name: 'Dino' })).toBeInTheDocument();
	});

	it('opens the Notifications dialog from a muted bell, instead of the details card', async () => {
		// The bell is hidden on a past pick — pin "now" to during Dino's own set.
		vi.setSystemTime(new Date(2026, 6, 16, 13, 30));
		render(RoomPage);
		await screen.findByText('Alex (you)');

		const dinoBlock = screen.getByText('Dino').closest('[role="button"]') as HTMLElement;
		await fireEvent.pointerUp(within(dinoBlock).getByRole('button', { name: 'Mark as going' }));
		await fireEvent.click(screen.getAllByRole('button', { name: /My Picks/ })[0]!);

		// Push was never turned on in this test, so the bell is muted.
		await fireEvent.click(screen.getByRole('button', { name: /tap to turn them on/ }));

		expect(await screen.findByRole('heading', { name: 'Notifications' })).toBeInTheDocument();
		expect(screen.queryByRole('dialog', { name: 'Dino' })).not.toBeInTheDocument();

		vi.useRealTimers();
	});

	it('opens and closes the Liked overlay from the menu', async () => {
		render(RoomPage);
		await screen.findByText('Alex (you)');

		await fireEvent.click(screen.getAllByRole('button', { name: 'More options' })[0]!);
		await fireEvent.click(screen.getByRole('button', { name: 'Liked' }));
		expect(screen.getByText('Open a performance and tap ♥ to save it here.')).toBeInTheDocument();

		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		await waitFor(() =>
			expect(
				screen.queryByText('Open a performance and tap ♥ to save it here.')
			).not.toBeInTheDocument()
		);
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
