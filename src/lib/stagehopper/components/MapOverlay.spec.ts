import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import MapOverlay from './MapOverlay.svelte';

// `bind:clientWidth/Height` compiles to a ResizeObserver, which jsdom lacks.
vi.stubGlobal(
	'ResizeObserver',
	class {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
);

function renderOverlay(overrides: { mapUrl?: string; onClose?: () => void } = {}) {
	const onClose = overrides.onClose ?? vi.fn();
	const result = render(MapOverlay, {
		props: { mapUrl: overrides.mapUrl ?? '/data/festival-maps/tmr26-abc.jpg', onClose }
	});
	return { ...result, onClose };
}

describe('MapOverlay', () => {
	it('renders the map image at the given url', () => {
		renderOverlay({ mapUrl: '/data/festival-maps/tmr26-abc.jpg' });

		const img = screen.getByAltText('Festival map') as HTMLImageElement;
		expect(img.getAttribute('src')).toBe('/data/festival-maps/tmr26-abc.jpg');
	});

	it('closes when the ✕ button is clicked', async () => {
		const { onClose } = renderOverlay();

		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));

		expect(onClose).toHaveBeenCalledOnce();
	});

	it('closes on Escape', async () => {
		const { onClose } = renderOverlay();

		await fireEvent.keyDown(window, { key: 'Escape' });

		expect(onClose).toHaveBeenCalledOnce();
	});

	it('shows a fallback message when the image fails to load', async () => {
		renderOverlay();

		await fireEvent.error(screen.getByAltText('Festival map'));

		expect(screen.getByText("Couldn't load the map.")).toBeInTheDocument();
	});
});
