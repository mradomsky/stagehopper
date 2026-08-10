import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import PerformanceBlock from './PerformanceBlock.svelte';
import { DAY_BOUNDARY_MIN, PX_PER_MIN } from '../time.js';
import type { ParticipantMark, Performance, SelectionState } from '../types.js';

const performance: Performance = {
	id: 'p1',
	artist: 'Massive Attack',
	stage: 'MAIN',
	startTime: '21:00',
	endTime: '22:30'
};

function renderBlock(
	overrides: {
		state?: SelectionState;
		marks?: ParticipantMark[];
		onOpen?: () => void;
		onToggleMark?: () => void;
		inert?: boolean;
		performance?: Performance;
	} = {}
) {
	return render(PerformanceBlock, {
		props: {
			performance: overrides.performance ?? performance,
			gridStartMin: DAY_BOUNDARY_MIN,
			state: overrides.state ?? 0,
			color: '#e74c3c',
			marks: overrides.marks ?? [],
			onOpen: overrides.onOpen ?? vi.fn(),
			onToggleMark: overrides.onToggleMark ?? vi.fn(),
			inert: overrides.inert ?? false
		}
	});
}

describe('PerformanceBlock', () => {
	it('shows the artist and time range', () => {
		renderBlock();

		expect(screen.getByText('Massive Attack')).toBeInTheDocument();
		expect(screen.getByText('21:00–22:30')).toBeInTheDocument();
	});

	it('positions and sizes the block from its clock times', () => {
		const { container } = renderBlock();

		const block = container.querySelector('.perf-block') as HTMLElement;
		expect(block.style.top).toBe(`${(21 * 60 - DAY_BOUNDARY_MIN) * PX_PER_MIN}px`);
		expect(block.style.height).toBe(`${90 * PX_PER_MIN}px`);
	});

	it('omits the time range on a set too short to show it', () => {
		renderBlock({
			performance: { ...performance, startTime: '21:00', endTime: '21:10' }
		});

		expect(screen.queryByText('21:00–21:10')).not.toBeInTheDocument();
	});

	it('opens the details card when the block is clicked', async () => {
		const onOpen = vi.fn();
		const { container } = renderBlock({ onOpen });

		await fireEvent.click(container.querySelector('.perf-block') as HTMLElement);

		expect(onOpen).toHaveBeenCalledOnce();
	});

	it('cycles the mark from the star without opening the details card', async () => {
		const onOpen = vi.fn();
		const onToggleMark = vi.fn();
		renderBlock({ onOpen, onToggleMark });

		const star = screen.getByRole('button', { name: 'Mark as going' });
		await fireEvent.pointerUp(star);
		await fireEvent.click(star);

		expect(onToggleMark).toHaveBeenCalledOnce();
		expect(onOpen).not.toHaveBeenCalled();
	});

	it('labels the star by the current mark', () => {
		renderBlock({ state: 2 });

		expect(screen.getByRole('button', { name: 'Marked as maybe' })).toHaveTextContent('★');
	});

	it('echoes the colour signal as a text label beside the time', () => {
		renderBlock({ state: 1 });
		expect(screen.getByText('attending')).toBeInTheDocument();

		renderBlock({ state: 2 });
		expect(screen.getByText('maybe')).toBeInTheDocument();
	});

	it('shows no selection label when unmarked', () => {
		renderBlock({ state: 0 });

		expect(screen.queryByText('attending')).not.toBeInTheDocument();
		expect(screen.queryByText('maybe')).not.toBeInTheDocument();
	});

	it('badges each other participant who marked the set', () => {
		renderBlock({
			marks: [
				{ userId: 'a', name: 'Sam', color: '#3498db', state: 1 },
				{ userId: 'b', name: 'kim', color: '#2ecc71', state: 2 }
			]
		});

		expect(screen.getByTitle('Sam')).toHaveTextContent('S');
		expect(screen.getByTitle('kim')).toHaveTextContent('K');
	});

	it('drops out of the tab order while a blocking modal is up', () => {
		const { container } = renderBlock({ inert: true });

		expect(container.querySelector('.perf-block')).toHaveAttribute('tabindex', '-1');
	});
});
