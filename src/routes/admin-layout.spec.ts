import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRawSnippet } from 'svelte';
import { render, screen, waitFor } from '@testing-library/svelte';
import { resetMockPage, setMockPage } from '../test-support/app-state.svelte.js';
import { saveGoogleAuth } from '$lib/stagehopper/storage.js';

vi.mock('$lib/stagehopper/auth.js', async () => {
	const storage = await vi.importActual<typeof import('$lib/stagehopper/storage.js')>(
		'$lib/stagehopper/storage.js'
	);
	// The token-refresh wrapper is unit-tested in auth.spec.ts; here it just reflects
	// whatever the test seeded into storage, so sign-in state stays test-controlled.
	return { ensureFreshGoogleAuth: async () => storage.loadGoogleAuth() };
});

const goto = vi.fn();
const checkAdmin = vi.fn();

vi.mock('$app/navigation', () => ({ goto: (...args: unknown[]) => goto(...args) }));

vi.mock('$app/state', async () => {
	const { mockPage } = await import('../test-support/app-state.svelte.js');
	return { page: mockPage };
});

vi.mock('$lib/stagehopper/api.js', () => ({
	checkAdmin: (...args: unknown[]) => checkAdmin(...args)
}));

const { default: AdminLayout } = await import('./admin/+layout.svelte');

function signIn() {
	saveGoogleAuth({ idToken: 'tok', sub: '123', name: 'Alex Example', givenName: 'Alex' });
}

/** A snippet prop cannot be handed in as a plain value, so this stands in for the page. */
function childrenSnippet(text = 'Page content') {
	return createRawSnippet(() => ({
		render: () => `<p>${text}</p>`
	}));
}

beforeEach(() => {
	goto.mockReset();
	checkAdmin.mockReset().mockResolvedValue(false);
	localStorage.clear();
	resetMockPage();
	setMockPage({ url: 'http://localhost/admin' });
});

afterEach(() => {
	localStorage.clear();
});

describe('admin layout — the gate', () => {
	it('sends a signed-out visitor home without asking the server', async () => {
		render(AdminLayout, { props: { children: childrenSnippet() } });

		await waitFor(() => expect(goto).toHaveBeenCalledWith('/'));
		expect(checkAdmin).not.toHaveBeenCalled();
		expect(screen.queryByText('Page content')).not.toBeInTheDocument();
	});

	it('sends a signed-in non-admin home', async () => {
		signIn();
		checkAdmin.mockResolvedValue(false);

		render(AdminLayout, { props: { children: childrenSnippet() } });

		await waitFor(() => expect(goto).toHaveBeenCalledWith('/'));
		expect(checkAdmin).toHaveBeenCalledWith('tok');
		expect(screen.queryByText('Page content')).not.toBeInTheDocument();
	});

	it('renders the shell and the page for an admin', async () => {
		signIn();
		checkAdmin.mockResolvedValue(true);

		render(AdminLayout, { props: { children: childrenSnippet() } });

		expect(await screen.findByText('Page content')).toBeInTheDocument();
		expect(goto).not.toHaveBeenCalled();
	});

	// Rendering the shell first and retracting it would flash admin nav at everyone on
	// their way to being redirected out, which is the one thing this gate must not do.
	it('renders nothing while the check is in flight', async () => {
		signIn();
		let resolveCheck: ((isAdmin: boolean) => void) | undefined;
		checkAdmin.mockReturnValue(
			new Promise<boolean>((resolve) => {
				resolveCheck = resolve;
			})
		);

		render(AdminLayout, { props: { children: childrenSnippet() } });

		await waitFor(() => expect(checkAdmin).toHaveBeenCalled());
		expect(screen.queryByText('Page content')).not.toBeInTheDocument();
		expect(goto).not.toHaveBeenCalled();

		resolveCheck?.(true);
		expect(await screen.findByText('Page content')).toBeInTheDocument();
	});
});

describe('admin layout — the sidebar nav', () => {
	beforeEach(() => {
		signIn();
		checkAdmin.mockResolvedValue(true);
	});

	it('links to every admin screen', async () => {
		render(AdminLayout, { props: { children: childrenSnippet() } });
		await screen.findByText('Page content');

		expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '/admin');
		expect(screen.getByRole('link', { name: 'Festivals' })).toHaveAttribute(
			'href',
			'/admin/festivals'
		);
		expect(screen.getByRole('link', { name: 'Rooms' })).toHaveAttribute('href', '/admin/rooms');
		expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute('href', '/admin/users');
	});

	it('marks the current section active', async () => {
		setMockPage({ url: 'http://localhost/admin/rooms' });

		render(AdminLayout, { props: { children: childrenSnippet() } });
		await screen.findByText('Page content');

		expect(screen.getByRole('link', { name: 'Rooms' }).className).toContain('active');
		expect(screen.getByRole('link', { name: 'Overview' }).className).not.toContain('active');
	});
});
