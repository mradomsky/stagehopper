import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import ParticipantLegend from './ParticipantLegend.svelte';
import type { RoomSelection } from '../types.js';

const viewer: RoomSelection = {
	userId: 'me',
	name: 'Alex',
	color: '#e74c3c',
	selections: {}
};
const friend: RoomSelection = {
	userId: 'friend',
	name: 'Sam',
	color: '#3498db',
	selections: {}
};

function renderLegend(
	overrides: {
		participants?: RoomSelection[];
		showFilters?: boolean;
		showingAll?: boolean;
		selected?: string[];
		dayCount?: number;
		currentDayIdx?: number;
	} = {}
) {
	const onShowAll = vi.fn();
	const onToggleParticipant = vi.fn();
	const selected = overrides.selected;
	const result = render(ParticipantLegend, {
		props: {
			dayCount: overrides.dayCount ?? 3,
			currentDayIdx: overrides.currentDayIdx ?? 0,
			showFilters: overrides.showFilters ?? true,
			participants: overrides.participants ?? [viewer, friend],
			viewerUserId: 'me',
			showingAll: overrides.showingAll ?? true,
			isSelected: (userId: string) => (selected ? selected.includes(userId) : true),
			onShowAll,
			onToggleParticipant
		}
	});
	return { ...result, onShowAll, onToggleParticipant };
}

describe('ParticipantLegend', () => {
	it('marks the viewer and names everyone else', () => {
		renderLegend();

		expect(screen.getByText('Alex (you)')).toBeInTheDocument();
		expect(screen.getByText('Sam')).toBeInTheDocument();
	});

	it('will not let the viewer filter themselves out', () => {
		renderLegend();

		expect(screen.getByRole('button', { name: /Alex/ })).toBeDisabled();
		expect(screen.getByRole('button', { name: /Sam/ })).toBeEnabled();
	});

	it('reports a participant being toggled', async () => {
		const { onToggleParticipant } = renderLegend();

		await fireEvent.click(screen.getByRole('button', { name: /Sam/ }));

		expect(onToggleParticipant).toHaveBeenCalledWith('friend');
	});

	it('resets the filter from the All chip', async () => {
		const { onShowAll } = renderLegend({ showingAll: false });

		await fireEvent.click(screen.getByRole('button', { name: 'All' }));

		expect(onShowAll).toHaveBeenCalledOnce();
	});

	it('conveys which participants are showing', () => {
		renderLegend({ selected: ['me'] });

		expect(screen.getByRole('button', { name: /Sam/ })).toHaveAttribute('aria-pressed', 'false');
		expect(screen.getByRole('button', { name: /Alex/ })).toHaveAttribute('aria-pressed', 'true');
	});

	it('keeps the All chip from the first paint, before anyone has loaded', () => {
		renderLegend({ participants: [] });

		expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
	});

	it('shows no filters at all to a guest browsing a lineup', () => {
		renderLegend({ showFilters: false, participants: [] });

		expect(screen.queryByRole('button', { name: 'All' })).not.toBeInTheDocument();
	});

	it('renders one day dot per day, marking the current one', () => {
		const { container } = renderLegend({ dayCount: 4, currentDayIdx: 2 });

		const dots = container.querySelectorAll('.day-dot');
		expect(dots).toHaveLength(4);
		expect(dots[2]).toHaveClass('day-dot-active');
		expect(dots[0]).not.toHaveClass('day-dot-active');
	});
});
