import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';
import { saveGoogleAuth } from '$lib/stagehopper/storage.js';
import { FESTIVALS } from '$lib/stagehopper/festivals.svelte.js';

const listAdminRooms = vi.fn();
const listAdminUsers = vi.fn();

vi.mock('$lib/stagehopper/api.js', () => ({
	listAdminRooms: (...args: unknown[]) => listAdminRooms(...args),
	listAdminUsers: (...args: unknown[]) => listAdminUsers(...args)
}));

const { default: AdminOverviewPage } = await import('./admin/+page.svelte');

function card(label: string) {
	return screen.getByText(label).closest('a')!;
}

beforeEach(() => {
	saveGoogleAuth({ idToken: 'tok', sub: '1', name: 'Admin', givenName: 'Admin' });
	listAdminRooms.mockReset();
	listAdminUsers.mockReset();
});

afterEach(() => {
	localStorage.clear();
});

describe('admin overview', () => {
	it('counts festivals synchronously and rooms/users from the live endpoints', async () => {
		listAdminRooms.mockResolvedValue({
			ok: true,
			data: { rooms: [{ roomId: 'a' }, { roomId: 'b' }], nextKey: null }
		});
		listAdminUsers.mockResolvedValue({
			ok: true,
			data: { users: [{ userId: 'google:1' }, { userId: 'google:2' }, { userId: 'google:3' }], nextKey: null }
		});
		render(AdminOverviewPage);

		expect(within(card('Festivals')).getByText(String(FESTIVALS.length))).toBeInTheDocument();
		expect(await within(card('Rooms')).findByText('2')).toBeInTheDocument();
		expect(await within(card('Users')).findByText('3')).toBeInTheDocument();
		expect(card('Rooms')).toHaveAttribute('href', '/admin/rooms');
		expect(card('Users')).toHaveAttribute('href', '/admin/users');
	});

	it('counts distinct ids across pages', async () => {
		listAdminRooms
			.mockResolvedValueOnce({ ok: true, data: { rooms: [{ roomId: 'a' }], nextKey: { k: 1 } } })
			.mockResolvedValueOnce({ ok: true, data: { rooms: [{ roomId: 'a' }, { roomId: 'b' }], nextKey: null } });
		listAdminUsers.mockResolvedValue({ ok: true, data: { users: [], nextKey: null } });
		render(AdminOverviewPage);

		// 'a' appears on both pages but counts once.
		expect(await within(card('Rooms')).findByText('2')).toBeInTheDocument();
	});

	it('falls back to a dash when a count cannot be loaded', async () => {
		listAdminRooms.mockResolvedValue({ ok: false, unauthorized: false, status: 500 });
		listAdminUsers.mockResolvedValue({ ok: false, unauthorized: false, status: 500 });
		render(AdminOverviewPage);

		expect(await within(card('Rooms')).findByText('—')).toBeInTheDocument();
		expect(within(card('Users')).getByText('—')).toBeInTheDocument();
	});
});
