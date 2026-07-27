import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { FIXTURE_FESTIVALS } from '$lib/stagehopper/admin/fixtures.js';

const { default: AdminFestivalsPage } = await import('./admin/festivals/+page.svelte');

function rowFor(name: string) {
	return screen.getByText(new RegExp(name)).closest('tr');
}

describe('admin festivals page', () => {
	it('lists every fixture festival', () => {
		render(AdminFestivalsPage);

		for (const festival of FIXTURE_FESTIVALS) {
			expect(screen.getByText(new RegExp(festival.name))).toBeInTheDocument();
		}
	});

	it('opens a blank create form and adds the festival to the list on save', async () => {
		render(AdminFestivalsPage);

		await fireEvent.click(screen.getByRole('button', { name: 'New festival' }));
		expect(screen.getByRole('dialog', { name: 'New festival' })).toBeInTheDocument();
		expect(screen.queryByText(/frozen/)).not.toBeInTheDocument();

		await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Test Fest 2027' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		expect(screen.getByText(/Test Fest 2027/)).toBeInTheDocument();
	});

	it('will not save a festival with no name', async () => {
		render(AdminFestivalsPage);

		await fireEvent.click(screen.getByRole('button', { name: 'New festival' }));

		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
	});

	it('opens the edit form pre-filled, with the id frozen', async () => {
		render(AdminFestivalsPage);
		const target = FIXTURE_FESTIVALS[0]!;

		const row = rowFor(target.name);
		await fireEvent.click(within(row!).getByRole('button', { name: 'Edit' }));

		expect(screen.getByLabelText('Name')).toHaveValue(target.name);
		expect(screen.getByText(new RegExp(target.id))).toBeInTheDocument();
	});

	it('edits an existing festival in place', async () => {
		render(AdminFestivalsPage);
		const target = FIXTURE_FESTIVALS[0]!;

		await fireEvent.click(within(rowFor(target.name)!).getByRole('button', { name: 'Edit' }));
		await fireEvent.input(screen.getByLabelText('Subtitle'), {
			target: { value: 'Updated subtitle' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(screen.getByText('Updated subtitle')).toBeInTheDocument();
		expect(screen.getAllByText(new RegExp(target.name))).toHaveLength(1);
	});

	it('deletes a festival after confirming', async () => {
		render(AdminFestivalsPage);
		const target = FIXTURE_FESTIVALS[0]!;

		await fireEvent.click(within(rowFor(target.name)!).getByRole('button', { name: 'Delete' }));
		const dialog = screen.getByRole('dialog', { name: 'Delete festival?' });

		await fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

		expect(screen.queryByText(new RegExp(target.name))).not.toBeInTheDocument();
	});

	it('keeps the festival on cancel', async () => {
		render(AdminFestivalsPage);
		const target = FIXTURE_FESTIVALS[0]!;

		await fireEvent.click(within(rowFor(target.name)!).getByRole('button', { name: 'Delete' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.getByText(new RegExp(target.name))).toBeInTheDocument();
	});
});
