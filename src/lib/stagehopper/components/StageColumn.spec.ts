import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import StageColumn from './StageColumn.svelte';
import { buildHourMarkers, DAY_BOUNDARY_MIN } from '../time.js';
import type { Performance, SelectionState } from '../types.js';

const performances: Performance[] = [
	{ id: 'p1', artist: 'Dino', stage: 'MAIN', startTime: '13:00', endTime: '14:00' },
	{ id: 'p2', artist: 'Amber Broos', stage: 'MAIN', startTime: '18:30', endTime: '19:30' }
];

function renderColumn(
	overrides: {
		stateOf?: (id: string) => SelectionState;
		notifyOf?: (id: string) => boolean;
		performances?: Performance[];
		favourite?: boolean;
		onToggleFavourite?: (() => void) | undefined;
	} = {}
) {
	const onOpenDetails = vi.fn();
	const onToggleMark = vi.fn();
	const result = render(StageColumn, {
		props: {
			stageName: 'THE GATHERING',
			performances: overrides.performances ?? performances,
			hourMarkers: buildHourMarkers(DAY_BOUNDARY_MIN),
			gridStartMin: DAY_BOUNDARY_MIN,
			gridHeightPx: 2160,
			color: '#e74c3c',
			stateOf: overrides.stateOf ?? (() => 0),
			marksOf: () => [],
			notifyOf: overrides.notifyOf,
			onOpenDetails,
			onToggleMark,
			favourite: overrides.favourite ?? false,
			onToggleFavourite: 'onToggleFavourite' in overrides ? overrides.onToggleFavourite : vi.fn()
		}
	});
	return { ...result, onOpenDetails, onToggleMark };
}

describe('StageColumn', () => {
	it('heads the column with the stage name', () => {
		renderColumn();

		expect(screen.getByTitle('THE GATHERING')).toHaveTextContent('THE GATHERING');
	});

	it('renders every performance on the stage', () => {
		renderColumn();

		expect(screen.getByText('Dino')).toBeInTheDocument();
		expect(screen.getByText('Amber Broos')).toBeInTheDocument();
	});

	it('draws a line for every hour of the grid', () => {
		const { container } = renderColumn();

		expect(container.querySelectorAll('.stage-hour-line')).toHaveLength(24);
	});

	it('passes the whole performance up when one is opened', async () => {
		const { onOpenDetails } = renderColumn();

		await fireEvent.click(screen.getByText('Amber Broos'));

		expect(onOpenDetails).toHaveBeenCalledWith(expect.objectContaining({ id: 'p2' }));
	});

	it('reports a mark by performance id', async () => {
		const { onToggleMark } = renderColumn();

		await fireEvent.pointerUp(screen.getAllByRole('button', { name: 'Mark as going' })[1]!);

		expect(onToggleMark).toHaveBeenCalledWith('p2');
	});

	it('gives each performance its own mark state', () => {
		renderColumn({ stateOf: (id) => (id === 'p1' ? 1 : 0) });

		expect(screen.getByRole('button', { name: 'Marked as going' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Mark as going' })).toBeInTheDocument();
	});

	it('gives each performance its own notification-bell state', () => {
		const { container } = renderColumn({ notifyOf: (id) => id === 'p1' });

		const blocks = container.querySelectorAll('.perf-block');
		expect(blocks[0]?.querySelector('.perf-notify')).not.toBeNull();
		expect(blocks[1]?.querySelector('.perf-notify')).toBeNull();
	});

	it('shows no bells when notifyOf is omitted', () => {
		const { container } = renderColumn();

		expect(container.querySelectorAll('.perf-notify')).toHaveLength(0);
	});

	it('renders an empty stage without complaint', () => {
		const { container } = renderColumn({ performances: [] });

		expect(container.querySelectorAll('.perf-block')).toHaveLength(0);
		expect(screen.getByTitle('THE GATHERING')).toBeInTheDocument();
	});

	it('toggles the favourite from the header', async () => {
		const onToggleFavourite = vi.fn();
		renderColumn({ onToggleFavourite });

		await fireEvent.click(screen.getByRole('button', { name: 'Favourite THE GATHERING' }));

		expect(onToggleFavourite).toHaveBeenCalledOnce();
	});

	it('shows a bright star and unfavourite label once favourited', () => {
		renderColumn({ favourite: true });

		const header = screen.getByRole('button', { name: 'Unfavourite THE GATHERING' });
		expect(header).toHaveTextContent('★');
		expect(header).toHaveAttribute('aria-pressed', 'true');
	});

	it('renders a plain, non-interactive header when favouriting is unavailable', () => {
		renderColumn({ onToggleFavourite: undefined });

		expect(screen.queryByRole('button', { name: /THE GATHERING/ })).not.toBeInTheDocument();
		expect(screen.getByTitle('THE GATHERING')).toHaveTextContent('THE GATHERING');
	});
});
