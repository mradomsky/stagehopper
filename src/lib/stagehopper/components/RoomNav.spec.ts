import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import RoomNav from './RoomNav.svelte';
import type { TimetableDay, ViewMode } from '../types.js';

const days: TimetableDay[] = [
	{ date: '2026-07-17', label: 'Friday, July 17', performances: [] },
	{ date: '2026-07-18', label: 'Saturday, July 18', performances: [] }
];

function renderNav(
	overrides: {
		currentDayIdx?: number;
		viewMode?: ViewMode;
		showViewTabs?: boolean;
		menuItems?: { label: string; onSelect: () => void }[];
	} = {}
) {
	const onSelectDay = vi.fn();
	const onSelectViewMode = vi.fn();
	const result = render(RoomNav, {
		props: {
			days,
			currentDayIdx: overrides.currentDayIdx ?? 0,
			viewMode: overrides.viewMode ?? 'full',
			showViewTabs: overrides.showViewTabs ?? true,
			menuItems: overrides.menuItems ?? [{ label: 'Share room', onSelect: vi.fn() }],
			onSelectDay,
			onSelectViewMode
		}
	});
	return { ...result, onSelectDay, onSelectViewMode };
}

describe('RoomNav', () => {
	it('offers a tab per festival day', () => {
		renderNav();

		expect(screen.getByRole('button', { name: 'Friday, July 17' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Saturday, July 18' })).toBeInTheDocument();
	});

	it('highlights the day being viewed', () => {
		renderNav({ currentDayIdx: 1 });

		expect(screen.getByRole('button', { name: 'Saturday, July 18' })).toHaveClass('tab-active');
		expect(screen.getByRole('button', { name: 'Friday, July 17' })).not.toHaveClass('tab-active');
	});

	it('reports the day the user picked', async () => {
		const { onSelectDay } = renderNav();

		await fireEvent.click(screen.getByRole('button', { name: 'Saturday, July 18' }));

		expect(onSelectDay).toHaveBeenCalledWith(1);
	});

	it('switches view mode', async () => {
		const { onSelectViewMode } = renderNav();

		await fireEvent.click(screen.getByRole('button', { name: '★ My Picks' }));

		expect(onSelectViewMode).toHaveBeenCalledWith('picks');
	});

	it('highlights the current view', () => {
		renderNav({ viewMode: 'picks' });

		expect(screen.getByRole('button', { name: '★ My Picks' })).toHaveClass('tab-active');
	});

	it('hides the view tabs from a guest, keeping the menu', () => {
		renderNav({ showViewTabs: false });

		expect(screen.queryByRole('button', { name: '★ My Picks' })).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'More options' })).toBeInTheDocument();
	});

	it('passes its menu items through to the options menu', async () => {
		const onSelect = vi.fn();
		renderNav({ menuItems: [{ label: 'Leave room', onSelect }] });

		await fireEvent.click(screen.getByRole('button', { name: 'More options' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));

		expect(onSelect).toHaveBeenCalledOnce();
	});
});
