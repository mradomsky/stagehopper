import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import TimetableList from './TimetableList.svelte';
import type { ScheduleDayGroup } from '../schedule-list.js';
import type { ParticipantMark, Performance, SelectionState } from '../types.js';

function performance(id: string, artist: string, overrides: Partial<Performance> = {}): Performance {
	return { id, artist, stage: 'MAINSTAGE', startTime: '20:00', endTime: '21:00', ...overrides };
}

const groups: ScheduleDayGroup[] = [
	{
		date: '2026-07-17',
		label: 'Friday, July 17',
		rows: [
			{ performance: performance('p1', 'MRMK', { startTime: '13:00', endTime: '14:00' }), timing: 'past' },
			{ performance: performance('p2', 'SOLOMUN', { stage: 'CELESTIA' }), timing: 'now' }
		]
	},
	{ date: '2026-07-18', label: 'Saturday, July 18', rows: [] }
];

interface RenderOverrides {
	groups?: ScheduleDayGroup[];
	todayDate?: string | null;
	stageColors?: Record<string, string>;
	currentDayIdx?: number;
	scrollTargetId?: string | null;
	stateOf?: (performanceId: string) => SelectionState;
	marksOf?: (performanceId: string) => ParticipantMark[];
	highlightedId?: string | null;
}

function renderList(overrides: RenderOverrides = {}) {
	const onOpen = vi.fn();
	const onToggleMark = vi.fn();
	const onDayInView = vi.fn();
	const result = render(TimetableList, {
		props: {
			groups: overrides.groups ?? groups,
			todayDate: overrides.todayDate ?? '2026-07-17',
			stageColors: overrides.stageColors,
			currentDayIdx: overrides.currentDayIdx ?? 0,
			scrollTargetId: overrides.scrollTargetId ?? null,
			stateOf: overrides.stateOf ?? (() => 0 as SelectionState),
			marksOf: overrides.marksOf ?? (() => []),
			onOpen,
			onToggleMark,
			onDayInView,
			highlightedId: overrides.highlightedId ?? null
		}
	});
	return { ...result, onOpen, onToggleMark, onDayInView };
}

/** The row element for an artist, which is what a tap on the row opens details from. */
function row(artist: string): HTMLElement {
	return screen.getByText(artist).closest('[role="button"]') as HTMLElement;
}

describe('TimetableList', () => {
	it('lists every set of every day in one run', () => {
		renderList();

		expect(screen.getByText('Friday, July 17')).toBeInTheDocument();
		expect(screen.getByText('MRMK')).toBeInTheDocument();
		expect(screen.getByText('SOLOMUN')).toBeInTheDocument();
		expect(screen.getByText('13:00–14:00')).toBeInTheDocument();
		expect(screen.getByText('CELESTIA')).toBeInTheDocument();
	});

	it('keeps a day with nothing scheduled, so the day tabs still line up', () => {
		renderList();

		expect(screen.getByText('Saturday, July 18')).toBeInTheDocument();
		expect(screen.getByText('Nothing scheduled.')).toBeInTheDocument();
	});

	it('badges the day in progress', () => {
		renderList();

		expect(screen.getByText('Today')).toBeInTheDocument();
	});

	it('opens a set’s details when its row is tapped', async () => {
		const { onOpen } = renderList();

		await fireEvent.click(row('SOLOMUN'));

		expect(onOpen).toHaveBeenCalledWith('p2');
	});

	it('cycles the mark from the star without opening the details card', async () => {
		const { onOpen, onToggleMark } = renderList();

		await fireEvent.click(within(row('SOLOMUN')).getByRole('button', { name: 'Mark as going' }));

		expect(onToggleMark).toHaveBeenCalledWith('p2');
		expect(onOpen).not.toHaveBeenCalled();
	});

	it('names the star for the mark it already carries', () => {
		renderList({ stateOf: (id) => (id === 'p2' ? 2 : 1) });

		expect(within(row('SOLOMUN')).getByRole('button', { name: 'Marked as maybe' })).toBeInTheDocument();
		// A past set keeps its star: a mark is a record, not a schedule.
		expect(within(row('MRMK')).getByRole('button', { name: 'Marked as going' })).toBeInTheDocument();
	});

	it('flags what is playing now, and dims what is over', () => {
		renderList();

		expect(screen.getByText('Playing now')).toBeInTheDocument();
		expect(row('MRMK')).toHaveClass('pick-item-past');
	});

	it('anchors a deep-linked set so the page can scroll to it', () => {
		renderList({ highlightedId: 'p2' });

		expect(row('SOLOMUN')).toHaveAttribute('id', 'perf-p2');
		expect(row('SOLOMUN')).toHaveClass('pick-item-highlight');
	});

	it('shows the viewer’s mark as a pill, and hides it when unmarked', () => {
		renderList({ stateOf: (id) => (id === 'p1' ? 1 : 0) });

		expect(within(row('MRMK')).getByText('attending')).toBeInTheDocument();
		expect(within(row('SOLOMUN')).queryByText('attending')).not.toBeInTheDocument();
	});

	it('shows who else is going, marked set or not', () => {
		renderList({
			marksOf: (id) =>
				id === 'p2' ? [{ userId: 'u1', name: 'Sam', color: '#3498db', state: 1 }] : []
		});

		expect(within(row('SOLOMUN')).getByTitle('Sam')).toHaveTextContent('S');
	});
});
