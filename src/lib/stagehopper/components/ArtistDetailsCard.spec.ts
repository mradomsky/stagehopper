import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import ArtistDetailsCard from './ArtistDetailsCard.svelte';
import type { Performance } from '../types.js';

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
		liked?: boolean;
		onToggleLike?: (() => void) | undefined;
		onClose?: () => void;
	} = {}
) {
	const onClose = overrides.onClose ?? vi.fn();
	const result = render(ArtistDetailsCard, {
		props: {
			performance: overrides.performance ?? performance,
			stageName: 'THE GREAT LIBRARY',
			liked: overrides.liked ?? false,
			onToggleLike: 'onToggleLike' in overrides ? overrides.onToggleLike : vi.fn(),
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

	it('shows the artist photo when the lineup has one', () => {
		renderCard({
			performance: {
				...performance,
				artists: [{ id: 'a', name: 'Illenium', image: 'https://cdn.example/illenium.jpg' }]
			}
		});

		expect(screen.getByRole('img', { name: 'Illenium' })).toHaveAttribute(
			'src',
			'https://cdn.example/illenium.jpg'
		);
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

	it('toggles the like from the heart button', async () => {
		const onToggleLike = vi.fn();
		renderCard({ onToggleLike });

		await fireEvent.click(screen.getByRole('button', { name: 'Add to liked' }));

		expect(onToggleLike).toHaveBeenCalledOnce();
	});

	it('reflects an existing like', () => {
		renderCard({ liked: true });

		const button = screen.getByRole('button', { name: 'Remove from liked' });
		expect(button).toHaveTextContent('♥');
		expect(button).toHaveAttribute('aria-pressed', 'true');
	});

	it('hides the heart when there is nowhere to save likes', () => {
		renderCard({ onToggleLike: undefined });

		expect(screen.queryByRole('button', { name: /liked/ })).not.toBeInTheDocument();
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
