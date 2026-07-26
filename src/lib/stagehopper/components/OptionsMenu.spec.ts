import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import OptionsMenu from './OptionsMenu.svelte';

describe('OptionsMenu', () => {
	it('stays closed until the trigger is pressed', async () => {
		render(OptionsMenu, { props: { items: [{ label: 'Share room', onSelect: vi.fn() }] } });

		expect(screen.queryByRole('button', { name: 'Share room' })).not.toBeInTheDocument();

		await fireEvent.click(screen.getByRole('button', { name: 'More options' }));

		expect(screen.getByRole('button', { name: 'Share room' })).toBeInTheDocument();
	});

	it('runs the chosen item and closes', async () => {
		const onSelect = vi.fn();
		render(OptionsMenu, { props: { items: [{ label: 'Leave room', onSelect }] } });
		await fireEvent.click(screen.getByRole('button', { name: 'More options' }));

		await fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));

		expect(onSelect).toHaveBeenCalledOnce();
		expect(screen.queryByRole('button', { name: 'Leave room' })).not.toBeInTheDocument();
	});

	it('closes when clicking outside the menu', async () => {
		render(OptionsMenu, { props: { items: [{ label: 'Sign out', onSelect: vi.fn() }] } });
		await fireEvent.click(screen.getByRole('button', { name: 'More options' }));

		await fireEvent.click(document.body);

		expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
	});

	it('reports its open state to assistive tech', async () => {
		render(OptionsMenu, { props: { items: [{ label: 'Share', onSelect: vi.fn() }] } });
		const trigger = screen.getByRole('button', { name: 'More options' });

		expect(trigger).toHaveAttribute('aria-expanded', 'false');
		await fireEvent.click(trigger);
		expect(trigger).toHaveAttribute('aria-expanded', 'true');
	});
});
