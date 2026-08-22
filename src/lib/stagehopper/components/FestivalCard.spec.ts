import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import FestivalCard from './FestivalCard.svelte';
import { normalizeFestival } from '../festivals.svelte.js';
import type { Festival, FestivalRecord } from '../types.js';

/** A festival's past-ness depends on today's date, so tests fix "today" rather than
 * relying on the real festival list not having aged past its own dates by the time
 * this runs. */
const RECORD: FestivalRecord = {
	id: 'tmr26',
	name: 'Tomorrowland 2026 – Week 1',
	location: 'Boom, Belgium',
	startDate: '2026-07-17',
	endDate: '2026-07-20'
};

const upcoming = normalizeFestival(RECORD, '2026-01-01');
const happeningNow = normalizeFestival(RECORD, '2026-07-18');
const past = normalizeFestival(RECORD, '2026-12-31');

function renderCard(festival: Festival = upcoming) {
	return render(FestivalCard, { props: { festival } });
}

describe('FestivalCard', () => {
	it('shows the festival name and where/when it is', () => {
		renderCard();

		expect(screen.getByText(upcoming.name)).toBeInTheDocument();
		expect(screen.getByText(upcoming.subtitle)).toBeInTheDocument();
	});

	it('links the whole card to the festival detail page', () => {
		renderCard();

		expect(screen.getByRole('link', { name: new RegExp(upcoming.name) })).toHaveAttribute(
			'href',
			`/festival/${upcoming.id}`
		);
	});

	it('badges an upcoming festival as live', () => {
		const { container } = renderCard();

		const badge = container.querySelector('.festival-badge') as HTMLElement;
		expect(badge).toHaveTextContent('Upcoming');
		expect(badge).toHaveClass('festival-badge-live');
	});

	it('badges a festival happening now with special styling', () => {
		const { container } = renderCard(happeningNow);

		const badge = container.querySelector('.festival-badge') as HTMLElement;
		expect(badge).toHaveTextContent('Happening now');
		expect(badge).toHaveClass('festival-badge-happening');
	});

	it('badges a past festival without the live styling', () => {
		const { container } = renderCard(past);

		const badge = container.querySelector('.festival-badge') as HTMLElement;
		expect(badge).toHaveTextContent('Past');
		expect(badge).not.toHaveClass('festival-badge-live');
	});

	describe('cover image', () => {
		it('shows the neutral placeholder cover when imageUrl is absent', () => {
			const { container } = renderCard();

			expect(container.querySelector('img')).not.toBeInTheDocument();
			expect(container.querySelector('.festival-cover')).toBeInTheDocument();
		});

		it('renders the full cover image over a blurred backdrop when imageUrl is present', () => {
			const withImage = { ...upcoming, imageUrl: '/data/festival-images/tmr26-abc.jpg' };
			const { container } = renderCard(withImage);

			const foreground = container.querySelector('.festival-cover-image') as HTMLImageElement;
			const backdrop = container.querySelector('.festival-cover-blur') as HTMLImageElement;
			expect(foreground).toHaveAttribute('src', withImage.imageUrl);
			expect(backdrop).toHaveAttribute('src', withImage.imageUrl);
			// The blurred backdrop is decorative and must not be announced.
			expect(backdrop).toHaveAttribute('aria-hidden', 'true');
		});

		it('falls back to the placeholder when the image fails to load', async () => {
			const withImage = { ...upcoming, imageUrl: '/data/festival-images/tmr26-abc.jpg' };
			const { container } = renderCard(withImage);

			await fireEvent.error(container.querySelector('.festival-cover-image') as HTMLImageElement);

			expect(container.querySelector('img')).not.toBeInTheDocument();
		});

		it('resets the failure state when the card is given a different festival', async () => {
			const withImage = { ...upcoming, imageUrl: '/data/festival-images/tmr26-abc.jpg' };
			const { container, rerender } = renderCard(withImage);
			await fireEvent.error(container.querySelector('.festival-cover-image') as HTMLImageElement);
			expect(container.querySelector('img')).not.toBeInTheDocument();

			const otherFestival = {
				...withImage,
				id: 'ps26',
				imageUrl: '/data/festival-images/ps26-xyz.jpg'
			};
			await rerender({ festival: otherFestival });

			expect(container.querySelector('img')).toBeInTheDocument();
		});
	});
});
