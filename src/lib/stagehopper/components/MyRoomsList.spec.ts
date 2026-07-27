import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import MyRoomsList from './MyRoomsList.svelte';
import type { RoomMembership } from '../types.js';

const rooms: RoomMembership[] = [
	{ roomId: 'tmr26-abc123', name: 'Alex', color: '#e74c3c', updatedAt: 20 },
	{ roomId: 'ps26-def456', name: 'Alex', color: '#3498db', updatedAt: 10 },
	{ roomId: 'birthday-party', name: 'Alex', color: '#2ecc71', updatedAt: 5 }
];

function renderList(overrides: { rooms?: RoomMembership[] } = {}) {
	const onOpen = vi.fn();
	const onLeave = vi.fn();
	const result = render(MyRoomsList, {
		props: { rooms: overrides.rooms ?? rooms, onOpen, onLeave }
	});
	return { ...result, onOpen, onLeave };
}

describe('MyRoomsList', () => {
	it('names each room by its festival', () => {
		renderList();

		expect(screen.getByText(/Tomorrowland 2026 – Week 1/)).toBeInTheDocument();
		expect(screen.getByText(/Primavera Sound Barcelona 2026/)).toBeInTheDocument();
	});

	it('falls back to the raw id for a custom room', () => {
		renderList();

		expect(screen.getByText(/birthday-party/)).toBeInTheDocument();
	});

	it('marks only rooms whose festival has already happened', () => {
		renderList();

		expect(screen.getAllByText('(Past)')).toHaveLength(1);
	});

	it('shows the colour claimed in each room', () => {
		const { container } = renderList();

		const swatch = container.querySelector('.my-room-swatch') as HTMLElement;
		expect(swatch.style.background).toBe('rgb(231, 76, 60)');
	});

	it('opens a room by id', async () => {
		const { onOpen } = renderList();

		await fireEvent.click(screen.getByText(/Primavera/));

		expect(onOpen).toHaveBeenCalledWith('ps26-def456');
	});

	it('asks to leave a room by id, naming it for assistive tech', async () => {
		const { onLeave } = renderList();

		await fireEvent.click(
			screen.getByRole('button', { name: 'Leave Tomorrowland 2026 – Week 1' })
		);

		expect(onLeave).toHaveBeenCalledWith('tmr26-abc123');
	});

	it('renders nothing for an empty list', () => {
		const { container } = renderList({ rooms: [] });

		expect(container.querySelectorAll('.my-room-item')).toHaveLength(0);
	});
});
