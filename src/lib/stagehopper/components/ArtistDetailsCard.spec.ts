import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import ArtistDetailsCard from './ArtistDetailsCard.svelte';
import type { Performance, SelectionState } from '../types.js';

const performance: Performance = {
	id: 'p1',
	artist: 'Illenium',
	stage: 'THE GREAT LIBRARY',
	startTime: '00:00',
	endTime: '00:55'
};

function renderCard(
	overrides: {
		performance?: Performance;
		state?: SelectionState;
		onToggleMark?: (() => void) | undefined;
		onClose?: () => void;
	} = {}
) {
	const onClose = overrides.onClose ?? vi.fn();
	const result = render(ArtistDetailsCard, {
		props: {
			performance: overrides.performance ?? performance,
			stageName: 'THE GREAT LIBRARY',
			state: overrides.state ?? 0,
			onToggleMark: 'onToggleMark' in overrides ? overrides.onToggleMark : vi.fn(),
			onClose
		}
	});
	return { ...result, onClose };
}

describe('ArtistDetailsCard', () => {
	it('shows the artist, stage and time', () => {
		renderCard();

		expect(screen.getByRole('heading', { name: 'Illenium' })).toBeInTheDocument();
		expect(screen.getByText('THE GREAT LIBRARY · 00:00–00:55')).toBeInTheDocument();
	});

	it('falls back to a placeholder when the artist has no photo', () => {
		const { container } = renderCard();

		expect(container.querySelector('.details-photo-placeholder')).toBeInTheDocument();
		expect(container.querySelector('img')).toBeNull();
	});

	it('shows the full artist photo over a blurred backdrop when the lineup has one', () => {
		const { container } = renderCard({
			performance: {
				...performance,
				artists: [{ id: 'a', name: 'Illenium', image: 'https://cdn.example/illenium.jpg' }]
			}
		});

		// The foreground carries the accessible name; the backdrop is decorative.
		expect(screen.getByRole('img', { name: 'Illenium' })).toHaveAttribute(
			'src',
			'https://cdn.example/illenium.jpg'
		);
		const backdrop = container.querySelector('.details-photo-bg') as HTMLImageElement;
		expect(backdrop).toHaveAttribute('src', 'https://cdn.example/illenium.jpg');
		expect(backdrop).toHaveAttribute('aria-hidden', 'true');
	});

	it('links out to each social profile the artist has', () => {
		renderCard({
			performance: {
				...performance,
				artists: [
					{
						id: 'a',
						name: 'Illenium',
						instagram: 'https://instagram.com/illenium',
						spotify: 'https://open.spotify.com/illenium'
					}
				]
			}
		});

		const instagram = screen.getByRole('link', { name: 'Instagram' });
		expect(instagram).toHaveAttribute('href', 'https://instagram.com/illenium');
		expect(instagram).toHaveAttribute('rel', 'noopener noreferrer');
		expect(screen.getByRole('link', { name: 'Spotify' })).toBeInTheDocument();
	});

	it('shows the artist bio and genre pills', () => {
		renderCard({
			performance: {
				...performance,
				artists: [
					{
						id: 'a',
						name: 'Illenium',
						bio: 'A producer of melodic bass.',
						genres: ['Melodic Bass', 'EDM']
					}
				]
			}
		});

		expect(screen.getByText('A producer of melodic bass.')).toBeInTheDocument();
		expect(screen.getByText('Melodic Bass')).toBeInTheDocument();
		expect(screen.getByText('EDM')).toBeInTheDocument();
	});

	it('omits bio and genres when the artist has none', () => {
		const { container } = renderCard({
			performance: { ...performance, artists: [{ id: 'a', name: 'Illenium' }] }
		});

		expect(container.querySelector('.details-bio')).toBeNull();
		expect(container.querySelector('.details-genres')).toBeNull();
	});

	it('falls back to the performance-level instagram link', () => {
		renderCard({ performance: { ...performance, instagram: 'https://instagram.com/illenium' } });

		expect(screen.getByRole('link', { name: 'Instagram' })).toBeInTheDocument();
	});

	it('cycles the mark from the star button', async () => {
		const onToggleMark = vi.fn();
		renderCard({ onToggleMark });

		await fireEvent.click(screen.getByRole('button', { name: 'Mark as going' }));

		expect(onToggleMark).toHaveBeenCalledOnce();
	});

	it('shows a filled star and the pill for a marked set', () => {
		renderCard({ state: 1 });

		expect(screen.getByRole('button', { name: 'Marked as going' })).toHaveTextContent('★');
		expect(screen.getByText('attending')).toBeInTheDocument();
	});

	it('shows the maybe pill for a maybe mark', () => {
		renderCard({ state: 2 });

		expect(screen.getByText('maybe')).toBeInTheDocument();
	});

	it('shows no pill when the set is unmarked', () => {
		renderCard({ state: 0 });

		expect(screen.queryByText('attending')).not.toBeInTheDocument();
		expect(screen.queryByText('maybe')).not.toBeInTheDocument();
	});

	it('hides the star when there is nothing to mark', () => {
		renderCard({ onToggleMark: undefined });

		expect(screen.queryByRole('button', { name: /Mark|Marked/ })).not.toBeInTheDocument();
	});

	it('closes on the close button, the backdrop and Escape', async () => {
		const { container, onClose } = renderCard();

		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		await fireEvent.click(container.querySelector('.details-backdrop') as HTMLElement);
		await fireEvent.keyDown(window, { key: 'Escape' });

		expect(onClose).toHaveBeenCalledTimes(3);
	});

	it('ignores clicks inside the card', async () => {
		const { container, onClose } = renderCard();

		await fireEvent.click(container.querySelector('.details-card') as HTMLElement);

		expect(onClose).not.toHaveBeenCalled();
	});
});
