import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import PicksList from './PicksList.svelte';
import type { ParticipantMark, Performance, SelectionState } from '../types.js';

function performance(id: string, artist: string, overrides: Partial<Performance> = {}): Performance {
	return {
		id,
		artist,
		stage: 'Main Stage',
		startTime: '20:00',
		endTime: '21:00',
		...overrides
	};
}

interface RenderOverrides {
	groups?: {
		date: string;
		label: string;
		performances: { performance: Performance; timing: 'past' | 'now' | 'soon' | 'future' }[];
	}[];
	todayDate?: string | null;
	scrollTargetId?: string | null;
	myColor?: string;
	stateOf?: (performanceId: string) => SelectionState;
	marksOf?: (performanceId: string) => ParticipantMark[];
	onOpen?: (performanceId: string) => void;
	onBrowseTimetable?: () => void;
}

function renderPicksList(overrides: RenderOverrides = {}) {
	const onOpen = overrides.onOpen ?? vi.fn();
	const onBrowseTimetable = overrides.onBrowseTimetable ?? vi.fn();
	const result = render(PicksList, {
		props: {
			groups: overrides.groups ?? [],
			todayDate: overrides.todayDate ?? null,
			scrollTargetId: overrides.scrollTargetId ?? null,
			myColor: overrides.myColor ?? '#e74c3c',
			stateOf: overrides.stateOf ?? (() => 1 as SelectionState),
			marksOf: overrides.marksOf ?? (() => []),
			onOpen,
			onBrowseTimetable
		}
	});
	return { ...result, onOpen, onBrowseTimetable };
}

describe('PicksList', () => {
	it('explains how to fill an empty list and offers a way back to the timetable', async () => {
		const { onBrowseTimetable } = renderPicksList();

		expect(screen.getByText('No picks yet — tap ★ on a set to add it here.')).toBeInTheDocument();

		await fireEvent.click(screen.getByRole('button', { name: 'Browse the timetable' }));
		expect(onBrowseTimetable).toHaveBeenCalled();
	});

	it('groups rows under a day header, with a TODAY badge on the current festival day', () => {
		const groups = [
			{
				date: '2026-07-17',
				label: 'Friday, July 17',
				performances: [{ performance: performance('a', 'Biffy Clyro'), timing: 'future' as const }]
			}
		];
		renderPicksList({ groups, todayDate: '2026-07-17' });

		expect(screen.getByText('Friday, July 17')).toBeInTheDocument();
		expect(screen.getByText('Today')).toBeInTheDocument();
		expect(screen.getByText('Biffy Clyro')).toBeInTheDocument();
	});

	it('omits the TODAY badge on a day that is not in progress', () => {
		const groups = [
			{
				date: '2026-07-17',
				label: 'Friday, July 17',
				performances: [{ performance: performance('a', 'Biffy Clyro'), timing: 'future' as const }]
			}
		];
		renderPicksList({ groups, todayDate: '2026-07-18' });

		expect(screen.queryByText('Today')).not.toBeInTheDocument();
	});

	it('shows the time and stage for a row', () => {
		const groups = [
			{
				date: '2026-07-17',
				label: 'Friday, July 17',
				performances: [
					{
						performance: performance('a', 'Biffy Clyro', {
							startTime: '19:15',
							endTime: '20:30',
							stage: 'Main Stage'
						}),
						timing: 'future' as const
					}
				]
			}
		];
		renderPicksList({ groups });

		expect(screen.getByText('19:15–20:30')).toBeInTheDocument();
		expect(screen.getByText('Main Stage')).toBeInTheDocument();
	});

	it.each([
		['now', 'Playing now'],
		['soon', 'Playing soon']
	] as const)('shows a "%s" pill that overrides the mark label', (timing, label) => {
		const groups = [
			{
				date: '2026-07-17',
				label: 'Friday, July 17',
				performances: [{ performance: performance('a', 'Chet Faker'), timing }]
			}
		];
		renderPicksList({ groups, stateOf: () => 2 });

		expect(screen.getByText(label)).toBeInTheDocument();
		expect(screen.queryByText('maybe')).not.toBeInTheDocument();
	});

	it('falls back to the mark label when nothing is playing or upcoming soon', () => {
		const groups = [
			{
				date: '2026-07-17',
				label: 'Friday, July 17',
				performances: [{ performance: performance('a', 'Chet Faker'), timing: 'future' as const }]
			}
		];
		renderPicksList({ groups, stateOf: () => 2 });

		expect(screen.getByText('maybe')).toBeInTheDocument();
	});

	it('dims a past row', () => {
		const groups = [
			{
				date: '2026-07-17',
				label: 'Friday, July 17',
				performances: [{ performance: performance('a', 'Biffy Clyro'), timing: 'past' as const }]
			}
		];
		renderPicksList({ groups });

		expect(screen.getByRole('button', { name: /Biffy Clyro/ })).toHaveClass('pick-item-past');
	});

	it('shows up to 5 other participant dots, then a "+N" chip', () => {
		const marks: ParticipantMark[] = Array.from({ length: 7 }, (_, i) => ({
			userId: `u${i}`,
			name: `Person ${i}`,
			color: '#3498db',
			state: 1
		}));
		const groups = [
			{
				date: '2026-07-17',
				label: 'Friday, July 17',
				performances: [{ performance: performance('a', 'Biffy Clyro'), timing: 'future' as const }]
			}
		];
		renderPicksList({ groups, marksOf: () => marks });

		expect(screen.getByText('+2')).toBeInTheDocument();
	});

	it('opens the details card for the row that was tapped', async () => {
		const groups = [
			{
				date: '2026-07-17',
				label: 'Friday, July 17',
				performances: [{ performance: performance('a', 'Biffy Clyro'), timing: 'future' as const }]
			}
		];
		const { onOpen } = renderPicksList({ groups });

		await fireEvent.click(screen.getByRole('button', { name: /Biffy Clyro/ }));

		expect(onOpen).toHaveBeenCalledWith('a');
	});

	it('falls back to an initial tile when there is no thumbnail image', () => {
		const groups = [
			{
				date: '2026-07-17',
				label: 'Friday, July 17',
				performances: [{ performance: performance('a', 'Biffy Clyro'), timing: 'future' as const }]
			}
		];
		renderPicksList({ groups });

		expect(screen.getByText('B')).toBeInTheDocument();
		expect(screen.queryByRole('img')).not.toBeInTheDocument();
	});

	it('prefers the artist card image over the flat performance image', () => {
		const groups = [
			{
				date: '2026-07-17',
				label: 'Friday, July 17',
				performances: [
					{
						performance: performance('a', 'Biffy Clyro', {
							artists: [{ image: 'https://example.com/artist-card.jpg' }],
							artistImage: 'https://example.com/flat.jpg'
						}),
						timing: 'future' as const
					}
				]
			}
		];
		const { container } = renderPicksList({ groups });

		// A decorative thumbnail (alt="") has no accessible "img" role — query the DOM directly.
		expect(container.querySelector('img')).toHaveAttribute('src', 'https://example.com/artist-card.jpg');
		expect(screen.queryByText('B')).not.toBeInTheDocument();
	});

	it('falls back to the flat performance image when there is no artist card image', () => {
		const groups = [
			{
				date: '2026-07-17',
				label: 'Friday, July 17',
				performances: [
					{
						performance: performance('a', 'Biffy Clyro', {
							artistImage: 'https://example.com/flat.jpg'
						}),
						timing: 'future' as const
					}
				]
			}
		];
		const { container } = renderPicksList({ groups });

		expect(container.querySelector('img')).toHaveAttribute('src', 'https://example.com/flat.jpg');
	});

	it('falls back to the initial tile once the thumbnail image fails to load', async () => {
		const groups = [
			{
				date: '2026-07-17',
				label: 'Friday, July 17',
				performances: [
					{
						performance: performance('a', 'Biffy Clyro', {
							artistImage: 'https://example.com/broken.jpg'
						}),
						timing: 'future' as const
					}
				]
			}
		];
		const { container } = renderPicksList({ groups });
		const img = container.querySelector('img') as HTMLImageElement;

		await fireEvent.error(img);

		expect(img).toHaveStyle({ display: 'none' });
	});
});
