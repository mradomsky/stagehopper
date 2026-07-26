import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import FestivalCard from './FestivalCard.svelte';
import { FESTIVALS } from '../festivals.js';
import type { Festival } from '../types.js';

const upcoming = FESTIVALS.find((f) => !f.past) as Festival;
const past = FESTIVALS.find((f) => f.past) as Festival;

function renderCard(
	overrides: { festival?: Festival; creating?: boolean; disabled?: boolean } = {}
) {
	const onCreateRoom = vi.fn();
	const result = render(FestivalCard, {
		props: {
			festival: overrides.festival ?? upcoming,
			creating: overrides.creating ?? false,
			disabled: overrides.disabled ?? false,
			onCreateRoom
		}
	});
	return { ...result, onCreateRoom };
}

describe('FestivalCard', () => {
	it('shows the festival name and where/when it is', () => {
		renderCard();

		expect(screen.getByText(upcoming.name)).toBeInTheDocument();
		expect(screen.getByText(upcoming.subtitle)).toBeInTheDocument();
	});

	it('links Browse to the festival lineup route', () => {
		renderCard();

		expect(screen.getByRole('link', { name: 'Browse' })).toHaveAttribute(
			'href',
			`/${upcoming.id}`
		);
	});

	it('badges an upcoming festival as live', () => {
		const { container } = renderCard();

		const badge = container.querySelector('.festival-badge') as HTMLElement;
		expect(badge).toHaveTextContent('Upcoming');
		expect(badge).toHaveClass('festival-badge-live');
	});

	it('badges a past festival without the live styling', () => {
		const { container } = renderCard({ festival: past });

		const badge = container.querySelector('.festival-badge') as HTMLElement;
		expect(badge).toHaveTextContent('Past');
		expect(badge).not.toHaveClass('festival-badge-live');
	});

	it('still offers a room for a festival that has already happened', () => {
		renderCard({ festival: past });

		expect(screen.getByRole('button', { name: 'Create room' })).toBeEnabled();
	});

	it('asks for a room when the button is pressed', async () => {
		const { onCreateRoom } = renderCard();

		await fireEvent.click(screen.getByRole('button', { name: 'Create room' }));

		expect(onCreateRoom).toHaveBeenCalledOnce();
	});

	it('shows progress on the card doing the work', () => {
		renderCard({ creating: true, disabled: true });

		expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();
	});

	it('locks its button while another card is creating a room', () => {
		renderCard({ creating: false, disabled: true });

		expect(screen.getByRole('button', { name: 'Create room' })).toBeDisabled();
	});
});
