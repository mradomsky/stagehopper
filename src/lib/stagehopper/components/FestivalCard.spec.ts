import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import FestivalCard from './FestivalCard.svelte';
import { normalizeFestival } from '../festivals.svelte.js';
import type { Festival, FestivalRecord, FestivalSummary } from '../types.js';

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

function renderCard(festival: Festival = upcoming, summary?: FestivalSummary) {
	return render(FestivalCard, { props: { festival, summary } });
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

	describe('summary', () => {
		const text = 'see you at the main stage';

		it('shows the Attendee count and the latest Message line', () => {
			renderCard(upcoming, { attendees: 12, latestMessage: { nickname: 'ana', text } });

			expect(screen.getByText('12 attending')).toBeInTheDocument();
			expect(screen.getByText(`ana: ${text}`)).toBeInTheDocument();
		});

		it('reads "1 attending" for one Attendee', () => {
			renderCard(upcoming, { attendees: 1, latestMessage: null });

			expect(screen.getByText('1 attending')).toBeInTheDocument();
		});

		it('shows neither element for an empty summary', () => {
			const { container } = renderCard(upcoming, { attendees: 0, latestMessage: null });

			expect(screen.queryByText(/attending/)).not.toBeInTheDocument();
			expect(container.querySelector('.festival-latest')).toBeNull();
		});

		it('shows only the count when there is no Message', () => {
			const { container } = renderCard(upcoming, { attendees: 3, latestMessage: null });

			expect(screen.getByText('3 attending')).toBeInTheDocument();
			expect(container.querySelector('.festival-latest')).toBeNull();
		});

		it('renders as before when no summary is given', () => {
			const { container } = renderCard(upcoming);

			expect(screen.queryByText(/attending/)).not.toBeInTheDocument();
			expect(container.querySelector('.festival-latest')).toBeNull();
		});

		it('keeps the whole card one link', () => {
			renderCard(upcoming, { attendees: 12, latestMessage: { nickname: 'ana', text } });

			expect(screen.getAllByRole('link')).toHaveLength(1);
		});
	});
});
