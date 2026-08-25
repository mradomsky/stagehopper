import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import ViewSwitchBar from './ViewSwitchBar.svelte';

describe('ViewSwitchBar', () => {
	it('names where the pill takes you, not where you are', () => {
		const { unmount } = render(ViewSwitchBar, { props: { layout: 'grid', onToggle: vi.fn() } });
		expect(screen.getByRole('button', { name: '☰ Switch to list view' })).toBeInTheDocument();
		unmount();

		render(ViewSwitchBar, { props: { layout: 'list', onToggle: vi.fn() } });
		expect(screen.getByRole('button', { name: '⊞ Switch to grid view' })).toBeInTheDocument();
	});

	it('reports a tap', async () => {
		const onToggle = vi.fn();
		render(ViewSwitchBar, { props: { layout: 'grid', onToggle } });

		await fireEvent.click(screen.getByRole('button', { name: '☰ Switch to list view' }));

		expect(onToggle).toHaveBeenCalledOnce();
	});
});
