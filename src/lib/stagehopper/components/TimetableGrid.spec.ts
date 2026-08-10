import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import TimetableGrid from './TimetableGrid.svelte';
import { buildHourMarkers, DAY_BOUNDARY_MIN } from '../time.js';
import type { Performance, StageWithPerformances } from '../types.js';

function perf(id: string, artist: string, startTime = '14:00'): Performance {
	return { id, artist, stage: 'MAIN', startTime, endTime: '15:00' };
}

const stages: StageWithPerformances[] = [
	{ name: 'MAIN', performances: [perf('p1', 'Massive Attack')] },
	{ name: 'SIDE', performances: [perf('p2', 'Bad Gyal', '16:00')] }
];

function renderGrid(
	overrides: {
		stages?: StageWithPerformances[];
		nowVisible?: boolean;
		onSwipeDay?: (delta: number) => void;
		onOpenDetails?: (performance: Performance, stageName: string) => void;
		picksOnly?: boolean;
		onTogglePicks?: (() => void) | undefined;
	} = {}
) {
	const onSwipeDay = overrides.onSwipeDay ?? vi.fn();
	const onOpenDetails = overrides.onOpenDetails ?? vi.fn();
	const result = render(TimetableGrid, {
		props: {
			stages: overrides.stages ?? stages,
			hourMarkers: buildHourMarkers(DAY_BOUNDARY_MIN),
			gridStartMin: DAY_BOUNDARY_MIN,
			gridHeightPx: 2160,
			nowTopPx: 300,
			nowVisible: overrides.nowVisible ?? false,
			color: '#e74c3c',
			stateOf: () => 0 as const,
			marksOf: () => [],
			onOpenDetails,
			onToggleMark: vi.fn(),
			onSwipeDay,
			picksOnly: overrides.picksOnly ?? false,
			onTogglePicks: 'onTogglePicks' in overrides ? overrides.onTogglePicks : vi.fn(),
			inert: false
		}
	});
	return { ...result, onSwipeDay, onOpenDetails };
}

/** Drive a touch gesture across the scroll container. */
async function swipe(
	element: HTMLElement,
	{ from, to, y = 200 }: { from: number; to: number; y?: number }
) {
	await fireEvent.touchStart(element, { touches: [{ clientX: from, clientY: y }] });
	await fireEvent.touchMove(element, { touches: [{ clientX: to, clientY: y }] });
	await fireEvent.touchEnd(element, { changedTouches: [{ clientX: to, clientY: y }] });
}

describe('TimetableGrid', () => {
	it('renders one column per stage with its performances', () => {
		renderGrid();

		expect(screen.getByTitle('MAIN')).toBeInTheDocument();
		expect(screen.getByTitle('SIDE')).toBeInTheDocument();
		expect(screen.getByText('Massive Attack')).toBeInTheDocument();
		expect(screen.getByText('Bad Gyal')).toBeInTheDocument();
	});

	it('renders a label for every hour of the grid', () => {
		const { container } = renderGrid();

		expect(container.querySelectorAll('.hour-label')).toHaveLength(24);
	});

	it('hides the now-line outside the visible window', () => {
		const { container } = renderGrid({ nowVisible: false });

		expect(container.querySelectorAll('.now-line')).toHaveLength(0);
	});

	it('draws the now-line across the time axis and the stage columns', () => {
		const { container } = renderGrid({ nowVisible: true });

		expect(container.querySelector('.now-line-time')).toBeInTheDocument();
		expect(container.querySelector('.now-line-grid')).toBeInTheDocument();
	});

	it('reports which stage a performance belongs to when opened', async () => {
		const { onOpenDetails } = renderGrid();

		await fireEvent.click(screen.getByText('Bad Gyal'));

		expect(onOpenDetails).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'p2' }),
			'SIDE'
		);
	});

	it('advances a day when swiping left from the right edge', async () => {
		const { container, onSwipeDay } = renderGrid();
		const scroll = container.querySelector('.grid-scroll') as HTMLElement;

		// jsdom reports zero scroll extents, so the grid counts as being at both edges.
		await swipe(scroll, { from: 300, to: 200 });

		expect(onSwipeDay).toHaveBeenCalledWith(1);
	});

	it('goes back a day when swiping right', async () => {
		const { container, onSwipeDay } = renderGrid();
		const scroll = container.querySelector('.grid-scroll') as HTMLElement;

		await swipe(scroll, { from: 200, to: 300 });

		expect(onSwipeDay).toHaveBeenCalledWith(-1);
	});

	it('ignores a mostly-vertical drag so scrolling never flips the day', async () => {
		const { container, onSwipeDay } = renderGrid();
		const scroll = container.querySelector('.grid-scroll') as HTMLElement;

		await fireEvent.touchStart(scroll, { touches: [{ clientX: 300, clientY: 400 }] });
		await fireEvent.touchMove(scroll, { touches: [{ clientX: 290, clientY: 200 }] });
		await fireEvent.touchEnd(scroll, { changedTouches: [{ clientX: 200, clientY: 200 }] });

		expect(onSwipeDay).not.toHaveBeenCalled();
	});

	it('ignores a short drag', async () => {
		const { container, onSwipeDay } = renderGrid();
		const scroll = container.querySelector('.grid-scroll') as HTMLElement;

		await swipe(scroll, { from: 300, to: 280 });

		expect(onSwipeDay).not.toHaveBeenCalled();
	});

	it('toggles the picks-only filter from the corner eye', async () => {
		const onTogglePicks = vi.fn();
		renderGrid({ onTogglePicks });

		await fireEvent.click(screen.getByRole('button', { name: 'Show only my picks' }));

		expect(onTogglePicks).toHaveBeenCalledOnce();
	});

	it('labels the eye as active when picks-only is on', () => {
		renderGrid({ picksOnly: true });

		const eye = screen.getByRole('button', { name: 'Show all performances' });
		expect(eye).toHaveClass('picks-eye-on');
		expect(eye).toHaveAttribute('aria-pressed', 'true');
	});

	it('hides the eye when picks filtering is unavailable', () => {
		renderGrid({ onTogglePicks: undefined });

		expect(screen.queryByRole('button', { name: /Show (only my picks|all performances)/ }))
			.not.toBeInTheDocument();
	});
});
