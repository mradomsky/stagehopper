import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRawSnippet } from 'svelte';
import { render, screen, waitFor } from '@testing-library/svelte';
import { resetMockPage, setMockPage } from '../test-support/app-state.svelte.js';

vi.mock('$lib/stagehopper/auth.svelte.js', () => ({
	// The layout waits for Clerk to resolve a session before asking the API whether this
	// caller is an admin. Whether they are is `checkAdmin`'s answer, mocked below.
	loadAuth: async () => null
}));

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
	// One question is asked now, not two. The layout no longer inspects a cached identity
	// before deciding whether to ask: `checkAdmin` answers false without a request when
	// there is no session to sign one with (see api.spec.ts), so a signed-out visitor and
	// a signed-in non-admin take the same path out.
	it('sends a signed-out visitor home', async () => {
		checkAdmin.mockResolvedValue(false);

		render(AdminLayout, { props: { children: childrenSnippet() } });

		await waitFor(() => expect(goto).toHaveBeenCalledWith('/'));
		expect(screen.queryByText('Page content')).not.toBeInTheDocument();
	});

	it('sends a signed-in non-admin home', async () => {
		checkAdmin.mockResolvedValue(false);

		render(AdminLayout, { props: { children: childrenSnippet() } });

		await waitFor(() => expect(goto).toHaveBeenCalledWith('/'));
		expect(checkAdmin).toHaveBeenCalled();
		expect(screen.queryByText('Page content')).not.toBeInTheDocument();
	});

	it('renders the shell and the page for an admin', async () => {
		checkAdmin.mockResolvedValue(true);

		render(AdminLayout, { props: { children: childrenSnippet() } });

		expect(await screen.findByText('Page content')).toBeInTheDocument();
		expect(goto).not.toHaveBeenCalled();
	});

	// Rendering the shell first and retracting it would flash admin nav at everyone on
	// their way to being redirected out, which is the one thing this gate must not do.
	it('renders nothing while the check is in flight', async () => {
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
