import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';

import { FESTIVALS } from '$lib/stagehopper/festivals.svelte.js';

const listAdminUsers = vi.fn();

vi.mock('$lib/stagehopper/api.js', () => ({
	listAdminUsers: (...args: unknown[]) => listAdminUsers(...args)
}));

const { default: AdminOverviewPage } = await import('./admin/+page.svelte');

function card(label: string) {
	return screen.getByText(label).closest('a')!;
}

beforeEach(() => {
	listAdminUsers.mockReset();
});

afterEach(() => {
	localStorage.clear();
});

describe('admin overview', () => {
	it('counts festivals synchronously and users from the live endpoint', async () => {
		listAdminUsers.mockResolvedValue({
			ok: true,
			data: { users: [{ userId: 'google:1' }, { userId: 'google:2' }, { userId: 'google:3' }], nextKey: null }
		});
		render(AdminOverviewPage);

		expect(within(card('Festivals')).getByText(String(FESTIVALS.length))).toBeInTheDocument();
		expect(await within(card('Users')).findByText('3')).toBeInTheDocument();
		expect(screen.queryByText('Rooms')).toBeNull();
		expect(card('Users')).toHaveAttribute('href', '/admin/users');
	});

	it('counts distinct ids across pages', async () => {
		listAdminUsers
			.mockResolvedValueOnce({ ok: true, data: { users: [{ userId: 'a' }], nextKey: { k: 1 } } })
			.mockResolvedValueOnce({ ok: true, data: { users: [{ userId: 'a' }, { userId: 'b' }], nextKey: null } });
		render(AdminOverviewPage);

		// 'a' appears on both pages but counts once.
		expect(await within(card('Users')).findByText('2')).toBeInTheDocument();
	});

	it('falls back to a dash when a count cannot be loaded', async () => {
		listAdminUsers.mockResolvedValue({ ok: false, unauthorized: false, status: 500 });
		render(AdminOverviewPage);

		expect(await within(card('Users')).findByText('—')).toBeInTheDocument();
	});
});
