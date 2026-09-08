import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The auth module with no browser around it — what happens at build time.
 *
 * The app builds with `adapter-static` and prerenders, so SvelteKit evaluates every module
 * in Node and renders HTML with no `window` in reach. Clerk grabs `window` the moment it is
 * constructed, so nothing here may construct it. The module's own header says getting that
 * wrong breaks the build rather than the runtime, which is the safer failure and the more
 * confusing one.
 *
 * A separate file rather than more cases in `auth.spec.ts`: the `browser` flag is a module
 * mock, and those are per file. This one mocks it false; that one mocks it true.
 */

const clerk = vi.hoisted(() => ({
	/** Bumped by the fake constructor. Must stay at zero for the whole file. */
	constructed: 0
}));

vi.mock('$app/environment', () => ({ browser: false }));
vi.mock('@clerk/ui', () => ({ ui: {} }));
vi.mock('@clerk/ui/themes', () => ({ dark: {} }));
vi.mock('@clerk/clerk-js', () => ({
	Clerk: class {
		constructor() {
			clerk.constructed++;
		}
	}
}));

type AuthModule = typeof import('./auth.svelte.js');

async function loadModule(key = 'pk_test_abc'): Promise<AuthModule> {
	vi.resetModules();
	vi.stubEnv('VITE_CLERK_PUBLISHABLE_KEY', key);
	return import('./auth.svelte.js');
}

// Resolve the graph once outside a timed test — see the note in auth.spec.ts.
beforeAll(async () => {
	await loadModule();
});

beforeEach(() => {
	clerk.constructed = 0;
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe('without a browser', () => {
	// The hazard itself, stated directly rather than inferred from the guards below. They are
	// how it holds today; this is what has to stay true however they are arranged.
	it('never constructs Clerk, whatever is asked of the module', async () => {
		const { loadAuth, getApiToken, signOut, mountSignIn, unmountSignIn } = await loadModule();

		await loadAuth();
		await getApiToken();
		await signOut();
		await mountSignIn(document.createElement('div'));
		unmountSignIn(document.createElement('div'));

		expect(clerk.constructed).toBe(0);
	});

	// Prerendered HTML is what every visitor sees first. `null` renders the signed-out view;
	// the loading value would bake a permanent "still checking" into the static page, since
	// nothing will ever resolve it there.
	it('starts from signed-out rather than still-loading', async () => {
		const { auth } = await loadModule();
		expect(auth.user).toBeNull();
	});

	it('reports no Clerk instance, and says nobody is signed in', async () => {
		const { auth, loadAuth } = await loadModule();

		expect(await loadAuth()).toBeNull();
		expect(auth.user).toBeNull();
	});

	it('reports no Clerk instance even with a publishable key present', async () => {
		// The key is baked in at build time, so it is present during prerender too — the
		// absence of a browser is what decides this, not the absence of configuration.
		const { loadAuth } = await loadModule('pk_live_real');

		expect(await loadAuth()).toBeNull();
		expect(clerk.constructed).toBe(0);
	});

	it('mints no token', async () => {
		const { getApiToken } = await loadModule();
		expect(await getApiToken()).toBeNull();
	});

	it('tears down nothing, without reaching for a Clerk that was never loaded', async () => {
		const { unmountSignIn } = await loadModule();
		expect(() => unmountSignIn(document.createElement('div'))).not.toThrow();
	});

	// Note for anyone chasing the last uncovered branch: the `!browser` half of the guard in
	// unmountSignIn cannot be observed, and no test here or elsewhere can catch its removal.
	// The stored Clerk promise is only ever assigned inside loadAuth, which returns before
	// that point without a browser — so the promise is always absent here, and the second
	// half of the condition decides on its own. It is kept as belt-and-braces next to the
	// two guards above that do decide something, not because a test is missing.

	it('still reports whether auth is configured', async () => {
		// Reads the baked-in key and nothing else, so it answers the same either side of the
		// browser boundary — the landing page calls it from component scope, during prerender.
		const configured = await loadModule('pk_live_real');
		expect(configured.isAuthConfigured()).toBe(true);

		const unconfigured = await loadModule('');
		expect(unconfigured.isAuthConfigured()).toBe(false);
	});
});
