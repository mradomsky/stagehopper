import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { FIXTURE_USERS } from '$lib/stagehopper/admin/fixtures.js';

const { default: AdminUsersPage } = await import('./admin/users/+page.svelte');

describe('admin users page', () => {
	it('lists every fixture user with their email', () => {
		render(AdminUsersPage);

		for (const user of FIXTURE_USERS) {
			const row = screen.getByText(user.name).closest('tr');
			expect(within(row!).getByText(user.email)).toBeInTheDocument();
		}
	});

	it('deletes a user after confirming', async () => {
		render(AdminUsersPage);
		const target = FIXTURE_USERS[0]!;
		const row = screen.getByText(target.name).closest('tr');

		await fireEvent.click(within(row!).getByRole('button', { name: 'Delete' }));
		const dialog = screen.getByRole('dialog', { name: 'Delete user?' });
		expect(dialog).toHaveTextContent(target.name);

		await fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

		expect(screen.queryByText(target.name)).not.toBeInTheDocument();
	});

	it('keeps the user on cancel', async () => {
		render(AdminUsersPage);
		const target = FIXTURE_USERS[0]!;
		const row = screen.getByText(target.name).closest('tr');

		await fireEvent.click(within(row!).getByRole('button', { name: 'Delete' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.getByText(target.name)).toBeInTheDocument();
	});
});
