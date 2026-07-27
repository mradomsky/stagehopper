import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import GoogleSignInModal from './GoogleSignInModal.svelte';
import GoogleSignInButton from './GoogleSignInButton.svelte';
import type { GoogleSignInError } from '../google-identity.js';

const initGoogleSignIn = vi.fn();
let clientId = 'test-client-id';

vi.mock('../google-identity.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../google-identity.js')>();
	return {
		...actual,
		getGoogleClientId: () => clientId,
		initGoogleSignIn: (...args: unknown[]) => initGoogleSignIn(...args)
	};
});

beforeEach(() => {
	clientId = 'test-client-id';
	initGoogleSignIn.mockReset().mockResolvedValue(null satisfies GoogleSignInError);
});

describe('GoogleSignInModal', () => {
	const props = {
		title: 'Sign in to continue',
		subtitle: 'Sign in with Google to save your picks.',
		onCredential: vi.fn()
	};

	it('shows what it is asking for', () => {
		render(GoogleSignInModal, { props });

		expect(screen.getByRole('heading', { name: 'Sign in to continue' })).toBeInTheDocument();
		expect(screen.getByText('Sign in with Google to save your picks.')).toBeInTheDocument();
	});

	it('starts Google sign-in against the host element it rendered', async () => {
		const onCredential = vi.fn();
		const { container } = render(GoogleSignInModal, { props: { ...props, onCredential } });

		await waitFor(() => expect(initGoogleSignIn).toHaveBeenCalledOnce());
		const options = initGoogleSignIn.mock.calls[0]?.[0];
		expect(options.clientId).toBe('test-client-id');
		expect(options.onCredential).toBe(onCredential);
		expect(options.buttonEl).toBe(container.querySelector('.sh-google-button'));
	});

	it('reports a script that failed to load', async () => {
		initGoogleSignIn.mockResolvedValue('script-failed' satisfies GoogleSignInError);
		render(GoogleSignInModal, { props });

		expect(await screen.findByText('Google auth script failed to load.')).toBeInTheDocument();
	});

	it('reports auth that is not configured at all', async () => {
		clientId = '';
		initGoogleSignIn.mockResolvedValue('no-client-id' satisfies GoogleSignInError);
		render(GoogleSignInModal, { props });

		expect(await screen.findByText('Google auth is unavailable.')).toBeInTheDocument();
	});

	it('shows an error raised by the caller, such as the wrong account', () => {
		render(GoogleSignInModal, {
			props: { ...props, error: 'Please sign in with the same Google account.' }
		});

		expect(
			screen.getByText('Please sign in with the same Google account.')
		).toBeInTheDocument();
	});

	it('offers no way out when the caller gave no cancel handler', () => {
		render(GoogleSignInModal, { props });

		expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
	});

	it('can be dismissed when the caller allows it', async () => {
		const onCancel = vi.fn();
		render(GoogleSignInModal, { props: { ...props, onCancel } });

		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(onCancel).toHaveBeenCalledOnce();
	});
});

describe('GoogleSignInButton', () => {
	it('renders Google into its host element', async () => {
		const onCredential = vi.fn();
		const { container } = render(GoogleSignInButton, { props: { onCredential } });

		await waitFor(() => expect(initGoogleSignIn).toHaveBeenCalledOnce());
		expect(initGoogleSignIn.mock.calls[0]?.[0].buttonEl).toBe(
			container.querySelector('.sh-google-button')
		);
	});

	it('hands a failure back to the page rather than rendering its own message', async () => {
		initGoogleSignIn.mockResolvedValue('unavailable' satisfies GoogleSignInError);
		const onError = vi.fn();

		render(GoogleSignInButton, { props: { onCredential: vi.fn(), onError } });

		await waitFor(() => expect(onError).toHaveBeenCalledWith('Google auth is unavailable.'));
	});

	it('stays silent when sign-in initializes cleanly', async () => {
		const onError = vi.fn();

		render(GoogleSignInButton, { props: { onCredential: vi.fn(), onError } });

		await waitFor(() => expect(initGoogleSignIn).toHaveBeenCalled());
		expect(onError).not.toHaveBeenCalled();
	});
});
