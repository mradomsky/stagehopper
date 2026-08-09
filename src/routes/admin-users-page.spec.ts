import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { saveGoogleAuth } from '$lib/stagehopper/storage.js';

vi.mock('$lib/stagehopper/auth.js', async () => {
	const storage = await vi.importActual<typeof import('$lib/stagehopper/storage.js')>(
		'$lib/stagehopper/storage.js'
	);
	// The token-refresh wrapper is unit-tested in auth.spec.ts; here it just reflects
	// whatever the test seeded into storage, so sign-in state stays test-controlled.
	return { ensureFreshGoogleAuth: async () => storage.loadGoogleAuth() };
});

const listAdminUsers = vi.fn();
const deleteAdminUser = vi.fn();

vi.mock('$lib/stagehopper/api.js', () => ({
	listAdminUsers: (...args: unknown[]) => listAdminUsers(...args),
	deleteAdminUser: (...args: unknown[]) => deleteAdminUser(...args)
}));

const { default: AdminUsersPage } = await import('./admin/users/+page.svelte');

interface UserRow {
	userId: string;
	name: string;
	email: string;
	roomCount: number;
	lastActive: number;
}

function usersPage(users: UserRow[], nextKey: unknown = null) {
	return { ok: true as const, data: { users, nextKey } };
}

const ALEX: UserRow = {
	userId: 'google:100000000000000000001',
	name: 'Alex Example',
	email: 'alex@example.com',
	roomCount: 3,
	lastActive: 300
};

beforeEach(() => {
	saveGoogleAuth({ idToken: 'tok', sub: '1', name: 'Admin', givenName: 'Admin' });
	listAdminUsers.mockReset();
	deleteAdminUser.mockReset();
});

afterEach(() => {
	localStorage.clear();
});

describe('admin users page', () => {
	it('lists each user with their email', async () => {
		listAdminUsers.mockResolvedValue(usersPage([ALEX]));
		render(AdminUsersPage);

		const row = (await screen.findByText('Alex Example')).closest('tr')!;
		expect(within(row).getByText('alex@example.com')).toBeInTheDocument();
		expect(within(row).getByText('3')).toBeInTheDocument();
	});

	it('shows a dash for a user whose rows predate email capture', async () => {
		listAdminUsers.mockResolvedValue(usersPage([{ ...ALEX, email: '' }]));
		render(AdminUsersPage);

		const row = (await screen.findByText('Alex Example')).closest('tr')!;
		expect(within(row).getByText('—')).toBeInTheDocument();
	});

	it('pages to the end and merges a user split across pages', async () => {
		listAdminUsers
			.mockResolvedValueOnce(usersPage([{ ...ALEX, roomCount: 2, lastActive: 10, email: '' }], { k: 1 }))
			.mockResolvedValueOnce(usersPage([{ ...ALEX, roomCount: 1, lastActive: 30 }]));
		render(AdminUsersPage);

		const row = (await screen.findByText('Alex Example')).closest('tr')!;
		// 2 + 1 rooms merged, and the fresher page (lastActive 30) supplies the email.
		expect(within(row).getByText('3')).toBeInTheDocument();
		expect(within(row).getByText('alex@example.com')).toBeInTheDocument();
		expect(listAdminUsers).toHaveBeenNthCalledWith(2, 'tok', { k: 1 });
	});

	it('requires typing the user id before delete is enabled, then deletes', async () => {
		listAdminUsers.mockResolvedValue(usersPage([ALEX]));
		deleteAdminUser.mockResolvedValue({ ok: true, data: { ok: true, deleted: 3 } });
		render(AdminUsersPage);

		const row = (await screen.findByText('Alex Example')).closest('tr')!;
		await fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));

		const dialog = screen.getByRole('dialog', { name: 'Delete user?' });
		const confirm = within(dialog).getByRole('button', { name: 'Delete user' });
		expect(confirm).toBeDisabled();

		await fireEvent.input(within(dialog).getByRole('textbox'), { target: { value: ALEX.userId } });
		expect(confirm).toBeEnabled();

		await fireEvent.click(confirm);

		expect(deleteAdminUser).toHaveBeenCalledWith('tok', ALEX.userId);
		await waitFor(() => expect(screen.queryByText('Alex Example')).not.toBeInTheDocument());
	});

	it('keeps the user on cancel', async () => {
		listAdminUsers.mockResolvedValue(usersPage([ALEX]));
		render(AdminUsersPage);

		const row = (await screen.findByText('Alex Example')).closest('tr')!;
		await fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.getByText('Alex Example')).toBeInTheDocument();
		expect(deleteAdminUser).not.toHaveBeenCalled();
	});
});
