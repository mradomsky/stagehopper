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
			title: 'Discard changes?',
			subtitle: 'Your picks in it will be deleted.',
			confirmLabel: 'Discard',
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

		const dialog = screen.getByRole('dialog', { name: 'Discard changes?' });
		expect(dialog).toHaveAttribute('aria-modal', 'true');
	});

	it('shows the title and subtitle', () => {
		renderDialog();

		expect(screen.getByRole('heading', { name: 'Discard changes?' })).toBeInTheDocument();
		expect(screen.getByText('Your picks in it will be deleted.')).toBeInTheDocument();
	});

	it('shows an error only when there is one', () => {
		const { container, rerender } = renderDialog();
		expect(container.querySelector('.sh-error')).not.toBeInTheDocument();

		rerender({ error: 'Could not discard. Please try again.' });

		expect(screen.getByText('Could not discard. Please try again.')).toBeInTheDocument();
	});
});

describe('ConfirmDialog', () => {
	it('confirms and cancels through its callbacks', async () => {
		const { onConfirm, onCancel } = renderDialog();

		await fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
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

		expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
	});

	it('takes a custom cancel label', () => {
		renderDialog({ cancelLabel: 'Stay' });

		expect(screen.getByRole('button', { name: 'Stay' })).toBeInTheDocument();
	});
});
