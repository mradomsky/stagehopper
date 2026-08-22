import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { resetMockPage, setMockPage } from '../test-support/app-state.svelte.js';
import { DEFAULT_FESTIVALS, FESTIVALS, normalizeFestival } from '$lib/stagehopper/festivals.svelte.js';
import { resetSession, setSessionUser } from '../test-support/auth-session.svelte.js';

const goto = vi.fn();
const createRoom = vi.fn();

vi.mock('$app/navigation', () => ({ goto: (...args: unknown[]) => goto(...args) }));

vi.mock('$app/state', async () => {
	const { mockPage } = await import('../test-support/app-state.svelte.js');
	return { page: mockPage };
});

vi.mock('$lib/stagehopper/api.js', () => ({
	createRoom: (...args: unknown[]) => createRoom(...args)
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

	it('renders nothing to browse when the festival id does not exist', () => {
		setMockPage({ params: { id: 'nope' } });
		render(FestivalPage);

		expect(screen.getByText("That festival doesn't exist.")).toBeInTheDocument();
		expect(screen.queryByRole('link', { name: 'Browse timetable' })).not.toBeInTheDocument();
	});

	it('links Browse timetable straight to the festival lineup, no auth gate', () => {
		render(FestivalPage);

		expect(screen.getByRole('link', { name: 'Browse timetable' })).toHaveAttribute(
			'href',
			'/room/tmr26'
		);
	});

	it('gates room creation behind sign-in, then creates once signed in', async () => {
		render(FestivalPage);

		await fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
		expect(screen.getByRole('dialog', { name: 'Sign in to continue' })).toBeInTheDocument();
		expect(createRoom).not.toHaveBeenCalled();

		setSessionUser();

		await waitFor(() => expect(createRoom).toHaveBeenCalledOnce());
		expect(createRoom.mock.calls[0]?.[0]).toMatch(/^tmr26-[0-9a-f]{6}$/);
		await waitFor(() => expect(goto).toHaveBeenCalledWith(expect.stringMatching(ROOM_PATH)));
	});

	it('creates a room straight away when already signed in', async () => {
		setSessionUser();
		render(FestivalPage);

		await fireEvent.click(screen.getByRole('button', { name: 'Create room' }));

		expect(screen.queryByRole('dialog', { name: 'Sign in to continue' })).not.toBeInTheDocument();
		await waitFor(() => expect(goto).toHaveBeenCalledWith(expect.stringMatching(ROOM_PATH)));
	});

	it('reports a failure to create a room and re-enables the button', async () => {
		setSessionUser();
		createRoom.mockResolvedValue({ ok: false, unauthorized: false, status: 500 });
		render(FestivalPage);

		await fireEvent.click(screen.getByRole('button', { name: 'Create room' }));

		await waitFor(() =>
			expect(screen.getByText('Could not create room. Please try again.')).toBeInTheDocument()
		);
		expect(goto).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: 'Create room' })).toBeEnabled();
	});

	it('lets the visitor back out of the sign-in gate', async () => {
		render(FestivalPage);
		await fireEvent.click(screen.getByRole('button', { name: 'Create room' }));

		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));

		expect(screen.queryByRole('dialog', { name: 'Sign in to continue' })).not.toBeInTheDocument();
		expect(createRoom).not.toHaveBeenCalled();
	});
});
