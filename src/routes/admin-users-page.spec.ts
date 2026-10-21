import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';

const listAdminUsers = vi.fn();
const deleteAdminUser = vi.fn();
const sendTestNotification = vi.fn();
const banAdminUser = vi.fn();
const unbanAdminUser = vi.fn();

vi.mock('$lib/stagehopper/api.js', () => ({
	listAdminUsers: (...args: unknown[]) => listAdminUsers(...args),
	deleteAdminUser: (...args: unknown[]) => deleteAdminUser(...args),
	sendTestNotification: (...args: unknown[]) => sendTestNotification(...args),
	banAdminUser: (...args: unknown[]) => banAdminUser(...args),
	unbanAdminUser: (...args: unknown[]) => unbanAdminUser(...args)
}));

const { default: AdminUsersPage } = await import('./admin/users/+page.svelte');

interface UserRow {
	userId: string;
	name: string;
	email: string;
	roomCount: number;
	lastActive: number;
	banned: boolean;
}

function usersPage(users: UserRow[], nextKey: unknown = null) {
	return { ok: true as const, data: { users, nextKey } };
}

const ALEX: UserRow = {
	userId: 'google:100000000000000000001',
	name: 'Alex Example',
	email: 'alex@example.com',
	roomCount: 3,
	lastActive: 300,
	banned: false
};

beforeEach(() => {
	listAdminUsers.mockReset();
	deleteAdminUser.mockReset();
	sendTestNotification.mockReset();
	banAdminUser.mockReset();
	unbanAdminUser.mockReset();
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
		expect(listAdminUsers).toHaveBeenNthCalledWith(2, { k: 1 });
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

		expect(deleteAdminUser).toHaveBeenCalledWith(ALEX.userId);
		await waitFor(() => expect(screen.queryByText('Alex Example')).not.toBeInTheDocument());
	});

	it('sends a test notification and shows how many devices were reached', async () => {
		listAdminUsers.mockResolvedValue(usersPage([ALEX]));
		sendTestNotification.mockResolvedValue({ ok: true, data: { ok: true, sent: 2, total: 2 } });
		render(AdminUsersPage);

		const row = (await screen.findByText('Alex Example')).closest('tr')!;
		await fireEvent.click(within(row).getByRole('button', { name: 'Send test' }));

		expect(sendTestNotification).toHaveBeenCalledWith(ALEX.userId);
		expect(await within(row).findByText(/Sent to 2\/2 devices/i)).toBeInTheDocument();
	});

	it('surfaces the reason when a test send reaches no devices', async () => {
		listAdminUsers.mockResolvedValue(usersPage([ALEX]));
		sendTestNotification.mockResolvedValue({ ok: false, error: 'The user has no devices that could be notified' });
		render(AdminUsersPage);

		const row = (await screen.findByText('Alex Example')).closest('tr')!;
		await fireEvent.click(within(row).getByRole('button', { name: 'Send test' }));

		expect(await within(row).findByText(/no devices that could be notified/i)).toBeInTheDocument();
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

	it('marks no one as Banned and offers Ban on an ordinary user', async () => {
		listAdminUsers.mockResolvedValue(usersPage([ALEX]));
		render(AdminUsersPage);

		const row = (await screen.findByText('Alex Example')).closest('tr')!;
		expect(within(row).queryByText('Banned')).not.toBeInTheDocument();
		expect(within(row).getByRole('button', { name: 'Ban' })).toBeInTheDocument();
		expect(within(row).queryByRole('button', { name: 'Unban' })).not.toBeInTheDocument();
	});

	it('bans only after the ConfirmDialog is confirmed, then shows Banned and Unban without reload', async () => {
		listAdminUsers.mockResolvedValue(usersPage([ALEX]));
		banAdminUser.mockResolvedValue({ ok: true, data: { ok: true, userId: ALEX.userId, banned: true } });
		render(AdminUsersPage);

		const row = (await screen.findByText('Alex Example')).closest('tr')!;
		await fireEvent.click(within(row).getByRole('button', { name: 'Ban' }));
		expect(banAdminUser).not.toHaveBeenCalled();

		const dialog = screen.getByRole('dialog', { name: 'Ban user?' });
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Ban user' }));

		expect(banAdminUser).toHaveBeenCalledWith(ALEX.userId);
		expect(await within(row).findByText('Banned')).toBeInTheDocument();
		expect(within(row).getByRole('button', { name: 'Unban' })).toBeInTheDocument();
		expect(within(row).queryByRole('button', { name: 'Ban' })).not.toBeInTheDocument();
		expect(listAdminUsers).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});

	it('keeps the user unbanned when the dialog is cancelled', async () => {
		listAdminUsers.mockResolvedValue(usersPage([ALEX]));
		render(AdminUsersPage);

		const row = (await screen.findByText('Alex Example')).closest('tr')!;
		await fireEvent.click(within(row).getByRole('button', { name: 'Ban' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(banAdminUser).not.toHaveBeenCalled();
		expect(within(row).queryByText('Banned')).not.toBeInTheDocument();
	});

	it('shows a Banned user from the list and unbans them', async () => {
		listAdminUsers.mockResolvedValue(usersPage([{ ...ALEX, banned: true }]));
		unbanAdminUser.mockResolvedValue({ ok: true, data: { ok: true, userId: ALEX.userId, banned: false } });
		render(AdminUsersPage);

		const row = (await screen.findByText('Alex Example')).closest('tr')!;
		expect(within(row).getByText('Banned')).toBeInTheDocument();
		await fireEvent.click(within(row).getByRole('button', { name: 'Unban' }));

		expect(unbanAdminUser).toHaveBeenCalledWith(ALEX.userId);
		await waitFor(() => expect(within(row).queryByText('Banned')).not.toBeInTheDocument());
		expect(within(row).getByRole('button', { name: 'Ban' })).toBeInTheDocument();
	});

	it('leaves the row unchanged and shows an error when the ban fails (status 0: unrouted HTML, 403, 404)', async () => {
		listAdminUsers.mockResolvedValue(usersPage([ALEX]));
		banAdminUser.mockResolvedValue({ ok: false, unauthorized: false, status: 0 });
		render(AdminUsersPage);

		const row = (await screen.findByText('Alex Example')).closest('tr')!;
		await fireEvent.click(within(row).getByRole('button', { name: 'Ban' }));
		const dialog = screen.getByRole('dialog', { name: 'Ban user?' });
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Ban user' }));

		expect(await within(dialog).findByText(/could not ban/i)).toBeInTheDocument();
		expect(within(row).queryByText('Banned')).not.toBeInTheDocument();
	});

	it('leaves the row unchanged and shows an error when the unban fails', async () => {
		listAdminUsers.mockResolvedValue(usersPage([{ ...ALEX, banned: true }]));
		unbanAdminUser.mockResolvedValue({ ok: false, unauthorized: false, status: 0 });
		render(AdminUsersPage);

		const row = (await screen.findByText('Alex Example')).closest('tr')!;
		await fireEvent.click(within(row).getByRole('button', { name: 'Unban' }));

		expect(await within(row).findByText(/could not unban/i)).toBeInTheDocument();
		expect(within(row).getByText('Banned')).toBeInTheDocument();
	});

	it('takes the new state from the response, not from the click', async () => {
		listAdminUsers.mockResolvedValue(usersPage([ALEX]));
		banAdminUser.mockResolvedValue({ ok: true, data: { ok: true, userId: ALEX.userId, banned: false } });
		render(AdminUsersPage);

		const row = (await screen.findByText('Alex Example')).closest('tr')!;
		await fireEvent.click(within(row).getByRole('button', { name: 'Ban' }));
		await fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Ban user' }));

		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
		expect(within(row).queryByText('Banned')).not.toBeInTheDocument();
	});

	it('keeps a deleted Banned user listed as Banned, with Unban available', async () => {
		listAdminUsers.mockResolvedValue(usersPage([{ ...ALEX, banned: true }]));
		deleteAdminUser.mockResolvedValue({ ok: true, data: { ok: true, deleted: 3 } });
		render(AdminUsersPage);

		const row = (await screen.findByText('Alex Example')).closest('tr')!;
		await fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
		const dialog = screen.getByRole('dialog', { name: 'Delete user?' });
		await fireEvent.input(within(dialog).getByRole('textbox'), { target: { value: ALEX.userId } });
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Delete user' }));

		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
		expect(within(row).getByText('Banned')).toBeInTheDocument();
		expect(within(row).getByRole('button', { name: 'Unban' })).toBeInTheDocument();
	});

	it('keeps Banned if either page of a split user says so', async () => {
		listAdminUsers
			.mockResolvedValueOnce(usersPage([{ ...ALEX, lastActive: 10, banned: true }], { k: 1 }))
			.mockResolvedValueOnce(usersPage([{ ...ALEX, lastActive: 30, banned: false }]));
		render(AdminUsersPage);

		const row = (await screen.findByText('Alex Example')).closest('tr')!;
		expect(within(row).getByText('Banned')).toBeInTheDocument();
	});

	it('renders a tombstone row (no name or email) with its userId, Banned and Unban', async () => {
		listAdminUsers.mockResolvedValue(usersPage([{ ...ALEX, name: '', email: '', roomCount: 0, banned: true }]));
		render(AdminUsersPage);

		const row = (await screen.findByText(ALEX.userId)).closest('tr')!;
		expect(within(row).getByText('Banned')).toBeInTheDocument();
		expect(within(row).getByRole('button', { name: 'Unban' })).toBeInTheDocument();
	});
});
