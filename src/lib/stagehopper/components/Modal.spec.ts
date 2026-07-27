import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import ConfirmDialog from './ConfirmDialog.svelte';

/**
 * `Modal` takes snippets, which cannot be handed in from a plain test module, so its
 * shell is exercised through `ConfirmDialog` — the wrapper every dialog in the app
 * actually uses.
 */
function renderDialog(
	overrides: {
		error?: string;
		busy?: boolean;
		busyLabel?: string;
		cancelLabel?: string;
	} = {}
) {
	const onConfirm = vi.fn();
	const onCancel = vi.fn();
	const result = render(ConfirmDialog, {
		props: {
			title: 'Leave this room?',
			subtitle: 'Your picks in it will be deleted.',
			confirmLabel: 'Leave room',
			onConfirm,
			onCancel,
			...overrides
		}
	});
	return { ...result, onConfirm, onCancel };
}

describe('Modal shell', () => {
	it('labels the dialog for assistive tech', () => {
		renderDialog();

		const dialog = screen.getByRole('dialog', { name: 'Leave this room?' });
		expect(dialog).toHaveAttribute('aria-modal', 'true');
	});

	it('shows the title and subtitle', () => {
		renderDialog();

		expect(screen.getByRole('heading', { name: 'Leave this room?' })).toBeInTheDocument();
		expect(screen.getByText('Your picks in it will be deleted.')).toBeInTheDocument();
	});

	it('shows an error only when there is one', () => {
		const { container, rerender } = renderDialog();
		expect(container.querySelector('.sh-error')).not.toBeInTheDocument();

		rerender({ error: 'Could not leave the room. Please try again.' });

		expect(screen.getByText('Could not leave the room. Please try again.')).toBeInTheDocument();
	});
});

describe('ConfirmDialog', () => {
	it('confirms and cancels through its callbacks', async () => {
		const { onConfirm, onCancel } = renderDialog();

		await fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(onConfirm).toHaveBeenCalledOnce();
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it('locks both buttons and shows progress while the action runs', () => {
		renderDialog({ busy: true, busyLabel: 'Leaving…' });

		expect(screen.getByRole('button', { name: 'Leaving…' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
	});

	it('keeps the plain label when busy without a busy label', () => {
		renderDialog({ busy: true });

		expect(screen.getByRole('button', { name: 'Leave room' })).toBeDisabled();
	});

	it('takes a custom cancel label', () => {
		renderDialog({ cancelLabel: 'Stay' });

		expect(screen.getByRole('button', { name: 'Stay' })).toBeInTheDocument();
	});
});
