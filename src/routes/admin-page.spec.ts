import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import { saveGoogleAuth } from '$lib/stagehopper/storage.js';

const checkAdmin = vi.fn();

vi.mock('$lib/stagehopper/api.js', () => ({
	checkAdmin: (...args: unknown[]) => checkAdmin(...args)
}));

const { default: AdminPage } = await import('./admin/+page.svelte');

function signIn() {
	saveGoogleAuth({ idToken: 'tok', sub: '123', name: 'Alex Example', givenName: 'Alex' });
}

beforeEach(() => {
	checkAdmin.mockReset().mockResolvedValue(false);
	localStorage.clear();
});

afterEach(() => {
	localStorage.clear();
});

describe('admin route', () => {
	it('opens the console for an admin', async () => {
		signIn();
		checkAdmin.mockResolvedValue(true);

		render(AdminPage);

		expect(await screen.findByRole('heading', { name: 'Admin' })).toBeInTheDocument();
		expect(checkAdmin).toHaveBeenCalledWith('tok');
	});

	it('turns away a signed-in user who is not an admin', async () => {
		signIn();

		render(AdminPage);

		expect(await screen.findByRole('heading', { name: 'Not available' })).toBeInTheDocument();
		expect(screen.queryByRole('heading', { name: 'Admin' })).not.toBeInTheDocument();
	});

	it('turns away a signed-out visitor without asking the server', async () => {
		render(AdminPage);

		expect(await screen.findByRole('heading', { name: 'Not available' })).toBeInTheDocument();
		expect(checkAdmin).not.toHaveBeenCalled();
	});

	// Rendering the console first and retracting it would flash admin chrome at everyone
	// who visits the URL, which is the one thing this page must not do.
	it('shows neither outcome until the server has answered', async () => {
		signIn();
		let resolveCheck: ((isAdmin: boolean) => void) | undefined;
		checkAdmin.mockReturnValue(
			new Promise<boolean>((resolve) => {
				resolveCheck = resolve;
			})
		);

		render(AdminPage);

		await waitFor(() => expect(checkAdmin).toHaveBeenCalled());
		expect(screen.getByText('Checking your access…')).toBeInTheDocument();
		expect(screen.queryByRole('heading', { name: 'Admin' })).not.toBeInTheDocument();
		expect(screen.queryByRole('heading', { name: 'Not available' })).not.toBeInTheDocument();

		resolveCheck?.(true);
		expect(await screen.findByRole('heading', { name: 'Admin' })).toBeInTheDocument();
	});
});
