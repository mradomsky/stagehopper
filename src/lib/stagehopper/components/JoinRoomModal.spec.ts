import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import JoinRoomModal from './JoinRoomModal.svelte';
import { PARTICIPANT_COLORS } from '../selections.js';

function renderModal(
	overrides: {
		name?: string;
		takenColors?: Set<string>;
		onConfirm?: () => void;
		onSelectColor?: (color: string) => void;
	} = {}
) {
	const onConfirm = overrides.onConfirm ?? vi.fn();
	const onSelectColor = overrides.onSelectColor ?? vi.fn();
	const result = render(JoinRoomModal, {
		props: {
			name: overrides.name ?? '',
			selectedColor: PARTICIPANT_COLORS[0],
			takenColors: overrides.takenColors ?? new Set<string>(),
			onSelectColor,
			onConfirm
		}
	});
	return { ...result, onConfirm, onSelectColor };
}

describe('JoinRoomModal', () => {
	it('offers one swatch per palette colour', () => {
		renderModal();

		expect(screen.getAllByRole('button', { name: /^Colour #/ })).toHaveLength(
			PARTICIPANT_COLORS.length
		);
	});

	it('disables a colour another participant already claimed', () => {
		renderModal({ takenColors: new Set([PARTICIPANT_COLORS[1]]) });

		expect(screen.getByRole('button', { name: `Colour ${PARTICIPANT_COLORS[1]} (taken)` })).toBeDisabled();
	});

	it('reports the chosen colour', async () => {
		const { onSelectColor } = renderModal();

		await fireEvent.click(screen.getByRole('button', { name: `Colour ${PARTICIPANT_COLORS[2]}` }));

		expect(onSelectColor).toHaveBeenCalledWith(PARTICIPANT_COLORS[2]);
	});

	it('will not join without a name', () => {
		renderModal({ name: '   ' });

		expect(screen.getByRole('button', { name: 'Join room' })).toBeDisabled();
	});

	it('joins on click once a name is entered', async () => {
		const { onConfirm } = renderModal({ name: 'Alex' });

		await fireEvent.click(screen.getByRole('button', { name: 'Join room' }));

		expect(onConfirm).toHaveBeenCalledOnce();
	});

	it('joins on Enter in the name field', async () => {
		const { onConfirm } = renderModal({ name: 'Alex' });

		await fireEvent.keyDown(screen.getByLabelText('Your name'), { key: 'Enter' });

		expect(onConfirm).toHaveBeenCalledOnce();
	});

	it('ignores Enter while the name is still empty', async () => {
		const { onConfirm } = renderModal({ name: '' });

		await fireEvent.keyDown(screen.getByLabelText('Your name'), { key: 'Enter' });

		expect(onConfirm).not.toHaveBeenCalled();
	});
});
