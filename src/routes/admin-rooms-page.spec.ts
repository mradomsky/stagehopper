import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { FIXTURE_ROOMS } from '$lib/stagehopper/admin/fixtures.js';

const { default: AdminRoomsPage } = await import('./admin/rooms/+page.svelte');

describe('admin rooms page', () => {
	it('lists every fixture room with its participant count', () => {
		render(AdminRoomsPage);

		for (const room of FIXTURE_ROOMS) {
			const row = screen.getByText(room.roomId).closest('tr');
			expect(within(row!).getByText(String(room.participantCount))).toBeInTheDocument();
		}
	});

	it('deletes a room after confirming', async () => {
		render(AdminRoomsPage);
		const target = FIXTURE_ROOMS[0]!;
		const row = screen.getByText(target.roomId).closest('tr');

		await fireEvent.click(within(row!).getByRole('button', { name: 'Delete' }));
		const dialog = screen.getByRole('dialog', { name: 'Delete room?' });
		expect(dialog).toHaveTextContent(target.roomId);

		await fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

		expect(screen.queryByText(target.roomId)).not.toBeInTheDocument();
	});

	it('keeps the room on cancel', async () => {
		render(AdminRoomsPage);
		const target = FIXTURE_ROOMS[0]!;
		const row = screen.getByText(target.roomId).closest('tr');

		await fireEvent.click(within(row!).getByRole('button', { name: 'Delete' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.getByText(target.roomId)).toBeInTheDocument();
	});
});
