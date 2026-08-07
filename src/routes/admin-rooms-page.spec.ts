import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { saveGoogleAuth } from '$lib/stagehopper/storage.js';

const listAdminRooms = vi.fn();
const deleteAdminRoom = vi.fn();

vi.mock('$lib/stagehopper/api.js', () => ({
	listAdminRooms: (...args: unknown[]) => listAdminRooms(...args),
	deleteAdminRoom: (...args: unknown[]) => deleteAdminRoom(...args)
}));

const { default: AdminRoomsPage } = await import('./admin/rooms/+page.svelte');

function roomsPage(
	rooms: { roomId: string; participantCount: number; updatedAt: number }[],
	nextKey: unknown = null
) {
	return { ok: true as const, data: { rooms, nextKey } };
}

beforeEach(() => {
	saveGoogleAuth({ idToken: 'tok', sub: '1', name: 'Admin', givenName: 'Admin' });
	listAdminRooms.mockReset();
	deleteAdminRoom.mockReset();
});

afterEach(() => {
	localStorage.clear();
});

describe('admin rooms page', () => {
	it('lists each room with its participant count', async () => {
		listAdminRooms.mockResolvedValue(
			roomsPage([
				{ roomId: 'tmr26-a1b2c3', participantCount: 4, updatedAt: 200 },
				{ roomId: 'our-crew', participantCount: 2, updatedAt: 100 }
			])
		);
		render(AdminRoomsPage);

		const row = (await screen.findByText('tmr26-a1b2c3')).closest('tr')!;
		expect(within(row).getByText('4')).toBeInTheDocument();
		expect(screen.getByText('our-crew')).toBeInTheDocument();
	});

	it('pages to the end and merges a room split across pages', async () => {
		listAdminRooms
			.mockResolvedValueOnce(roomsPage([{ roomId: 'r1', participantCount: 2, updatedAt: 10 }], { k: 1 }))
			.mockResolvedValueOnce(
				roomsPage([
					{ roomId: 'r1', participantCount: 1, updatedAt: 30 },
					{ roomId: 'r2', participantCount: 5, updatedAt: 20 }
				])
			);
		render(AdminRoomsPage);

		const row = (await screen.findByText('r1')).closest('tr')!;
		// 2 (page 1) + 1 (page 2) — the merge, not either page alone.
		expect(within(row).getByText('3')).toBeInTheDocument();
		// The second call honoured the continuation token from the first.
		expect(listAdminRooms).toHaveBeenNthCalledWith(2, 'tok', { k: 1 });
	});

	it('requires typing the room id before delete is enabled, then deletes', async () => {
		listAdminRooms.mockResolvedValue(roomsPage([{ roomId: 'tmr26-a1b2c3', participantCount: 4, updatedAt: 200 }]));
		deleteAdminRoom.mockResolvedValue({ ok: true, data: { ok: true, deleted: 4 } });
		render(AdminRoomsPage);

		const row = (await screen.findByText('tmr26-a1b2c3')).closest('tr')!;
		await fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));

		const dialog = screen.getByRole('dialog', { name: 'Delete room?' });
		const confirm = within(dialog).getByRole('button', { name: 'Delete room' });
		expect(confirm).toBeDisabled();

		await fireEvent.input(within(dialog).getByRole('textbox'), { target: { value: 'tmr26-a1b2c3' } });
		expect(confirm).toBeEnabled();

		await fireEvent.click(confirm);

		expect(deleteAdminRoom).toHaveBeenCalledWith('tok', 'tmr26-a1b2c3');
		await waitFor(() => expect(screen.queryByText('tmr26-a1b2c3')).not.toBeInTheDocument());
	});

	it('keeps the room and shows the server message when delete fails', async () => {
		listAdminRooms.mockResolvedValue(roomsPage([{ roomId: 'tmr26-a1b2c3', participantCount: 4, updatedAt: 200 }]));
		deleteAdminRoom.mockResolvedValue({ ok: false, unauthorized: false, status: 500, error: 'boom' });
		render(AdminRoomsPage);

		const row = (await screen.findByText('tmr26-a1b2c3')).closest('tr')!;
		await fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
		const dialog = screen.getByRole('dialog', { name: 'Delete room?' });
		await fireEvent.input(within(dialog).getByRole('textbox'), { target: { value: 'tmr26-a1b2c3' } });
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Delete room' }));

		expect(await screen.findByText('boom')).toBeInTheDocument();
		// Still in the table (the dialog stays open and also shows the id, hence getAll).
		expect(screen.getAllByText('tmr26-a1b2c3').length).toBeGreaterThan(0);
	});

	it('keeps the room on cancel', async () => {
		listAdminRooms.mockResolvedValue(roomsPage([{ roomId: 'tmr26-a1b2c3', participantCount: 4, updatedAt: 200 }]));
		render(AdminRoomsPage);

		const row = (await screen.findByText('tmr26-a1b2c3')).closest('tr')!;
		await fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.getByText('tmr26-a1b2c3')).toBeInTheDocument();
		expect(deleteAdminRoom).not.toHaveBeenCalled();
	});

	it('shows an error when the listing fails', async () => {
		listAdminRooms.mockResolvedValue({ ok: false, unauthorized: false, status: 500, error: 'nope' });
		render(AdminRoomsPage);

		expect(await screen.findByText('nope')).toBeInTheDocument();
	});
});
