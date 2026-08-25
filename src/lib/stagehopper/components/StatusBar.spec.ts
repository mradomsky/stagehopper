import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import StatusBar from './StatusBar.svelte';

describe('StatusBar', () => {
	it('takes up no room when there is nothing to say', () => {
		const { container } = render(StatusBar, { props: {} });

		expect(container.querySelector('.status-bar')).not.toBeInTheDocument();
	});

	it('announces itself so a sync failure is not missed', () => {
		render(StatusBar, { props: { error: 'Sync failed. Retrying…' } });

		expect(screen.getByRole('status')).toHaveTextContent('Sync failed. Retrying…');
	});

	it('stays out of the way once the error clears', () => {
		const { container } = render(StatusBar, { props: { error: '' } });

		expect(container.querySelector('.status-bar')).not.toBeInTheDocument();
	});
});
