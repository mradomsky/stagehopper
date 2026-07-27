import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import MobileBottomBar from './MobileBottomBar.svelte';
import type { ViewMode } from '../types.js';

function renderBar(
	overrides: {
		viewMode?: ViewMode;
		showViewTabs?: boolean;
		menuItems?: { label: string; onSelect: () => void }[];
	} = {}
) {
	const onSelectViewMode = vi.fn();
	const result = render(MobileBottomBar, {
		props: {
			viewMode: overrides.viewMode ?? 'full',
			showViewTabs: overrides.showViewTabs ?? true,
			menuItems: overrides.menuItems ?? [{ label: 'Share room', onSelect: vi.fn() }],
			onSelectViewMode
		}
	});
	return { ...result, onSelectViewMode };
}

describe('MobileBottomBar', () => {
	it('offers all three views plus the menu', () => {
		renderBar();

		expect(screen.getByRole('button', { name: '⊞ Timetable' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: '★ Picks' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: '♥ Liked' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'More options' })).toBeInTheDocument();
	});

	it('marks the active view', () => {
		renderBar({ viewMode: 'picks' });

		expect(screen.getByRole('button', { name: '★ Picks' })).toHaveClass('bottom-btn-active');
		expect(screen.getByRole('button', { name: '⊞ Timetable' })).not.toHaveClass(
			'bottom-btn-active'
		);
	});

	it('switches view mode', async () => {
		const { onSelectViewMode } = renderBar();

		await fireEvent.click(screen.getByRole('button', { name: '♥ Liked' }));

		expect(onSelectViewMode).toHaveBeenCalledWith('liked');
	});

	it('leaves a guest only the menu', () => {
		renderBar({ showViewTabs: false });

		expect(screen.queryByRole('button', { name: '★ Picks' })).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'More options' })).toBeInTheDocument();
	});

	it('opens its menu upwards, clear of the bar', async () => {
		const { container } = renderBar();

		await fireEvent.click(screen.getByRole('button', { name: 'More options' }));

		expect(container.querySelector('.menu-dropdown-up')).toBeInTheDocument();
	});
});
