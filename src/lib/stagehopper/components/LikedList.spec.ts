import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import LikedList from './LikedList.svelte';
import type { LikedPerformance } from '../types.js';

const liked: LikedPerformance[] = [
	{
		id: 'p1',
		artist: 'Massive Attack',
		stage: 'ESTRELLA DAMM',
		startTime: '21:00',
		endTime: '22:30',
		date: '2026-06-04',
		dayLabel: 'Thursday, June 4'
	},
	{
		id: 'p2',
		artist: 'Bad Gyal',
		stage: 'PULL&BEAR',
		startTime: '01:20',
		endTime: '02:50',
		date: '2026-06-05',
		dayLabel: 'Friday, June 5'
	}
];

describe('LikedList', () => {
	it('explains how to fill an empty list', () => {
		render(LikedList, { props: { performances: [], onRemove: vi.fn(), onOpen: vi.fn() } });

		expect(screen.getByText('Open a performance and tap ♥ to save it here.')).toBeInTheDocument();
	});

	it('shows each liked set with its stage, time and day', () => {
		render(LikedList, { props: { performances: liked, onRemove: vi.fn(), onOpen: vi.fn() } });

		expect(screen.getByText('Massive Attack')).toBeInTheDocument();
		expect(
			screen.getByText('ESTRELLA DAMM · 21:00–22:30 · Thursday, June 4')
		).toBeInTheDocument();
		expect(screen.getByText('Bad Gyal')).toBeInTheDocument();
	});

	it('removes the set the user chose, by id', async () => {
		const onRemove = vi.fn();
		render(LikedList, { props: { performances: liked, onRemove, onOpen: vi.fn() } });

		await fireEvent.click(screen.getByRole('button', { name: 'Remove Bad Gyal from liked' }));

		expect(onRemove).toHaveBeenCalledWith('p2');
	});

	it('opens the details card for the set the user tapped, by id', async () => {
		const onOpen = vi.fn();
		render(LikedList, { props: { performances: liked, onRemove: vi.fn(), onOpen } });

		await fireEvent.click(screen.getByText('Massive Attack'));

		expect(onOpen).toHaveBeenCalledWith('p1');
	});

	it('drops the empty-state message once something is liked', () => {
		render(LikedList, { props: { performances: liked, onRemove: vi.fn(), onOpen: vi.fn() } });

		expect(screen.queryByText(/tap ♥/)).not.toBeInTheDocument();
	});
});
