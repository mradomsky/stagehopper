import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import ProfileModal from './ProfileModal.svelte';
import { PARTICIPANT_COLORS } from '../selections.js';

const [RED, BLUE] = PARTICIPANT_COLORS as readonly string[] as [string, string];

function renderModal(profile: { nickname: string; colour: string | null } | null, error = '') {
	const onSave = vi.fn();
	const onCancel = vi.fn();
	render(ProfileModal, { props: { profile, error, onSave, onCancel } });
	return { onSave, onCancel };
}

const nickname = () => screen.getByLabelText('Nickname') as HTMLInputElement;
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));

describe('ProfileModal', () => {
	it('focuses the Nickname input and shows the stored values', () => {
		renderModal({ nickname: 'alex', colour: BLUE });
		expect(nickname()).toHaveFocus();
		expect(nickname().value).toBe('alex');
		expect(screen.getByRole('button', { name: `Colour ${BLUE}` })).toHaveAttribute('aria-pressed', 'true');
	});

	it('sends only the changed Nickname', async () => {
		const { onSave } = renderModal({ nickname: 'alex', colour: RED });
		await fireEvent.input(nickname(), { target: { value: ' alexa ' } });
		await save();
		expect(onSave).toHaveBeenCalledExactlyOnceWith({ nickname: 'alexa' });
	});

	it('sends only the changed Colour', async () => {
		const { onSave } = renderModal({ nickname: 'alex', colour: RED });
		await fireEvent.click(screen.getByRole('button', { name: `Colour ${BLUE}` }));
		await save();
		expect(onSave).toHaveBeenCalledExactlyOnceWith({ colour: BLUE });
	});

	it('an unchanged, complete form saves an empty change: the caller sends no request', async () => {
		const { onSave } = renderModal({ nickname: 'alex', colour: RED });
		await save();
		expect(onSave).toHaveBeenCalledExactlyOnceWith({});
	});

	it('refuses a bad Nickname without calling onSave', async () => {
		const { onSave } = renderModal({ nickname: 'alex', colour: RED });
		await fireEvent.input(nickname(), { target: { value: 'a b' } });
		await save();
		expect(onSave).not.toHaveBeenCalled();
		expect(screen.getByText(/2 to 20 characters/)).toBeInTheDocument();
	});

	it('requires a Nickname when the stored one is empty', async () => {
		const { onSave } = renderModal({ nickname: '', colour: RED });
		await save();
		expect(onSave).not.toHaveBeenCalled();
		expect(screen.getByText(/2 to 20 characters/)).toBeInTheDocument();
	});

	it('requires a Colour when none is stored', async () => {
		const { onSave } = renderModal({ nickname: 'alex', colour: null });
		await save();
		expect(onSave).not.toHaveBeenCalled();
		expect(screen.getByText(/choose a colour/i)).toBeInTheDocument();
		await fireEvent.click(screen.getByRole('button', { name: `Colour ${RED}` }));
		await save();
		expect(onSave).toHaveBeenCalledExactlyOnceWith({ colour: RED });
	});

	it('shows the error it is given and cancels', async () => {
		const { onCancel } = renderModal({ nickname: 'alex', colour: RED }, 'nickname taken');
		expect(screen.getByText('nickname taken')).toBeInTheDocument();
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it('opens empty for a Profile that has not loaded', async () => {
		const { onSave } = renderModal(null);
		await fireEvent.input(nickname(), { target: { value: 'sam' } });
		await fireEvent.click(screen.getByRole('button', { name: `Colour ${RED}` }));
		await save();
		expect(onSave).toHaveBeenCalledExactlyOnceWith({ nickname: 'sam', colour: RED });
	});
});
