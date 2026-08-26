import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { resetMockPage, setMockPage } from '../test-support/app-state.svelte.js';
import { DEFAULT_FESTIVALS, FESTIVALS, normalizeFestival } from '$lib/stagehopper/festivals.svelte.js';
import { resetSession, setSessionUser } from '../test-support/auth-session.svelte.js';

const goto = vi.fn();
const createRoom = vi.fn();
const listMyRooms = vi.fn();
const fetchRoomDisplayNames = vi.fn();

vi.mock('$app/navigation', () => ({ goto: (...args: unknown[]) => goto(...args) }));

vi.mock('$app/state', async () => {
	const { mockPage } = await import('../test-support/app-state.svelte.js');
	return { page: mockPage };
});

vi.mock('$lib/stagehopper/api.js', () => ({
	createRoom: (...args: unknown[]) => createRoom(...args),
	listMyRooms: (...args: unknown[]) => listMyRooms(...args),
	fetchRoomDisplayNames: (...args: unknown[]) => fetchRoomDisplayNames(...args)
}));

vi.mock('$lib/stagehopper/auth.svelte.js', async () => {
	const { mockAuthModule } = await import('../test-support/auth-session.svelte.js');
	return mockAuthModule();
});

const { default: FestivalPage } = await import('./festival/[id]/+page.svelte');

const ROOM_PATH = /^\/room\/tmr26-[0-9a-f]{6}$/;

beforeEach(() => {
	goto.mockReset();
	createRoom.mockReset().mockResolvedValue({ ok: true, data: { roomId: 'tmr26-abc123' } });
	listMyRooms.mockReset().mockResolvedValue({ ok: true, data: [] });
	fetchRoomDisplayNames.mockReset().mockResolvedValue({});
	resetSession();
	resetMockPage();
	setMockPage({ params: { id: 'tmr26' } });
	FESTIVALS.splice(
		0,
		FESTIVALS.length,
		...DEFAULT_FESTIVALS.map((r) => normalizeFestival(r, '2026-01-01'))
	);
});

describe('festival detail page', () => {
	it('shows the festival name, dates, and a back link', () => {
		render(FestivalPage);

		expect(screen.getByRole('heading', { name: 'Tomorrowland 2026 – Week 1' })).toBeInTheDocument();
		expect(screen.getByText('Boom, Belgium · July 17–20')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: /Back/ })).toHaveAttribute('href', '/');
	});

	it('shows the description when the festival has one', () => {
		FESTIVALS.splice(
			0,
			1,
			normalizeFestival({ ...DEFAULT_FESTIVALS[0]!, description: 'Four days of music.' }, '2026-01-01')
		);
		render(FestivalPage);

		expect(screen.getByText('Four days of music.')).toBeInTheDocument();
	});

	it('lists the viewer’s own rooms for this festival before the description', async () => {
		setSessionUser();
		listMyRooms.mockResolvedValue({
			ok: true,
			data: [
				{ roomId: 'tmr26-abc123', name: 'Alex', color: '#e74c3c', updatedAt: 1 },
				{ roomId: 'ps26-def456', name: 'Alex', color: '#e74c3c', updatedAt: 2 }
			]
		});
		FESTIVALS.splice(
			0,
			1,
			normalizeFestival({ ...DEFAULT_FESTIVALS[0]!, description: 'Four days of music.' }, '2026-01-01')
		);

		render(FestivalPage);

		await waitFor(() => expect(screen.getByText('Your rooms')).toBeInTheDocument());
		expect(screen.getByRole('button', { name: /Tomorrowland 2026/ })).toBeInTheDocument();
		expect(screen.queryByText(/Primavera/)).not.toBeInTheDocument();

		const rooms = screen.getByText('Your rooms').compareDocumentPosition(
			screen.getByText('Four days of music.')
		);
		// DOCUMENT_POSITION_FOLLOWING (4): the description comes after "Your rooms" in the DOM.
		expect(rooms & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it('shows no rooms section for a signed-out visitor or one with no rooms here', () => {
		render(FestivalPage);

		expect(screen.queryByText('Your rooms')).not.toBeInTheDocument();
	});

	it('renders nothing to browse when the festival id does not exist', () => {
		setMockPage({ params: { id: 'nope' } });
		render(FestivalPage);

		expect(screen.getByText("That festival doesn't exist.")).toBeInTheDocument();
		expect(screen.queryByRole('link', { name: 'Timetable' })).not.toBeInTheDocument();
	});

	it('links Timetable straight to the festival lineup, no auth gate', () => {
		render(FestivalPage);

		expect(screen.getByRole('link', { name: 'Timetable' })).toHaveAttribute('href', '/room/tmr26');
	});

	it('gates room creation behind sign-in, then opens the create-room dialog once signed in', async () => {
		render(FestivalPage);

		await fireEvent.click(screen.getByRole('button', { name: 'New room' }));
		expect(screen.getByRole('dialog', { name: 'Sign in to continue' })).toBeInTheDocument();
		expect(screen.queryByRole('dialog', { name: 'Create a room' })).not.toBeInTheDocument();

		setSessionUser();

		await waitFor(() =>
			expect(screen.getByRole('dialog', { name: 'Create a room' })).toBeInTheDocument()
		);
		expect(createRoom).not.toHaveBeenCalled();
	});

	it('opens the create-room dialog straight away when already signed in', async () => {
		setSessionUser();
		render(FestivalPage);

		await fireEvent.click(screen.getByRole('button', { name: 'New room' }));

		expect(screen.queryByRole('dialog', { name: 'Sign in to continue' })).not.toBeInTheDocument();
		expect(screen.getByRole('dialog', { name: 'Create a room' })).toBeInTheDocument();
	});

	it('sends a typed room name along when creating a room', async () => {
		setSessionUser();
		render(FestivalPage);

		await fireEvent.click(screen.getByRole('button', { name: 'New room' }));
		await fireEvent.input(screen.getByLabelText('Room name (optional)'), {
			target: { value: 'Squad Goals' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Create room' }));

		await waitFor(() => expect(createRoom).toHaveBeenCalledOnce());
		// (roomId, festivalId, displayName) — the festival id indexes the room for the
		await waitFor(() => expect(goto).toHaveBeenCalledWith(expect.stringMatching(ROOM_PATH)));
	});

	it('creates a room with no name when the field is left blank', async () => {
		setSessionUser();
		render(FestivalPage);

		await fireEvent.click(screen.getByRole('button', { name: 'New room' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Create room' }));

		await waitFor(() => expect(createRoom).toHaveBeenCalledOnce());
		expect(createRoom.mock.calls[0]?.[1]).toBe('tmr26');
		expect(createRoom.mock.calls[0]?.[2]).toBeUndefined();
		expect(createRoom.mock.calls[0]?.[0]).toMatch(/^tmr26-[0-9a-f]{6}$/);
	});

	it('disables room creation and explains why for an invalid name', async () => {
		setSessionUser();
		render(FestivalPage);

		await fireEvent.click(screen.getByRole('button', { name: 'New room' }));
		await fireEvent.input(screen.getByLabelText('Room name (optional)'), {
			target: { value: 'Not Allowed!' }
		});

		expect(screen.getByText(/letters, numbers/i)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Create room' })).toBeDisabled();
		expect(createRoom).not.toHaveBeenCalled();
	});

	it('closes the create-room dialog on cancel without creating anything', async () => {
		setSessionUser();
		render(FestivalPage);

		await fireEvent.click(screen.getByRole('button', { name: 'New room' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.queryByRole('dialog', { name: 'Create a room' })).not.toBeInTheDocument();
		expect(createRoom).not.toHaveBeenCalled();
	});

	it('shows a room’s custom name in the existing-rooms list', async () => {
		setSessionUser();
		listMyRooms.mockResolvedValue({
			ok: true,
			data: [{ roomId: 'tmr26-abc123', name: 'Alex', color: '#e74c3c', updatedAt: 1 }]
		});
		fetchRoomDisplayNames.mockResolvedValue({ 'tmr26-abc123': 'Squad Goals' });

		render(FestivalPage);

		expect(await screen.findByRole('button', { name: 'Squad Goals' })).toBeInTheDocument();
	});

	it('reports a failure to create a room and re-enables the button', async () => {
		setSessionUser();
		createRoom.mockResolvedValue({ ok: false, unauthorized: false, status: 500 });
		render(FestivalPage);

		await fireEvent.click(screen.getByRole('button', { name: 'New room' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Create room' }));

		await waitFor(() =>
			expect(screen.getByText('Could not create room. Please try again.')).toBeInTheDocument()
		);
		expect(goto).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: 'Create room' })).toBeEnabled();
	});

	it('lets the visitor back out of the sign-in gate', async () => {
		render(FestivalPage);
		await fireEvent.click(screen.getByRole('button', { name: 'New room' }));

		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));

		expect(screen.queryByRole('dialog', { name: 'Sign in to continue' })).not.toBeInTheDocument();
		expect(screen.queryByRole('dialog', { name: 'Create a room' })).not.toBeInTheDocument();
		expect(createRoom).not.toHaveBeenCalled();
	});
});
