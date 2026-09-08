import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Clerk faked at the package boundary, which is the seam this module already has: it reaches
 * the SDK only through three dynamic imports. Nothing here asserts Clerk's own behaviour —
 * only the decisions this file makes around it.
 *
 * The module caches its loaded instance in module scope, so every test re-imports it after
 * `vi.resetModules()` rather than sharing one.
 */

interface FakeClerkUser {
	id: string;
	fullName: string | null;
	username: string | null;
	firstName: string | null;
	primaryEmailAddress: { emailAddress: string } | null;
}

const clerk = vi.hoisted(() => {
	const state = {
		/** Every instance the module has constructed, newest last. */
		created: [] as FakeClerk[],
		/** When true, `load()` rejects — the "Clerk could not be brought up" path. */
		loadRejects: false
	};

	class FakeClerk {
		user: FakeClerkUser | null = null;
		session: { getToken: (options: { template: string }) => Promise<string> } | null = null;
		loadOptions: Record<string, unknown> | null = null;
		listeners: (() => void)[] = [];
		mountSignIn = vi.fn();
		unmountSignIn = vi.fn();
		/**
		 * Drops the session without notifying listeners.
		 *
		 * Deliberately not emitting: when a real SDK tells its listeners, relative to the
		 * promise resolving, is its own business. A fake that emits synchronously here does
		 * the module's work for it, so `auth.user = null` in signOut could be deleted with
		 * every test still green — while a caller that navigates the moment signOut resolves
		 * would render a stale signed-in user.
		 */
		signOut = vi.fn(async () => {
			this.user = null;
		});

		constructor(readonly publishableKey: string) {}

		async load(options: Record<string, unknown>): Promise<void> {
			this.loadOptions = options;
			if (state.loadRejects) throw new Error('Clerk is down');
		}

		addListener(fn: () => void): void {
			this.listeners.push(fn);
		}

		/** What Clerk does on sign-in or sign-out: tell whoever registered a listener. */
		emit(): void {
			for (const fn of this.listeners) fn();
		}
	}

	return { state, FakeClerk };
});

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('@clerk/ui', () => ({ ui: { fake: 'ui-bundle' } }));
vi.mock('@clerk/ui/themes', () => ({ dark: { fake: 'dark-theme' } }));
vi.mock('@clerk/clerk-js', () => ({
	Clerk: class {
		constructor(key: string) {
			const instance = new clerk.FakeClerk(key);
			clerk.state.created.push(instance);
			return instance as never;
		}
	}
}));

type AuthModule = typeof import('./auth.svelte.js');

/** Re-import the module with a chosen publishable key, discarding the cached instance. */
async function loadModule(key = 'pk_test_abc'): Promise<AuthModule> {
	vi.resetModules();
	vi.stubEnv('VITE_CLERK_PUBLISHABLE_KEY', key);
	return import('./auth.svelte.js');
}

/** The Clerk instance the module most recently built. */
function latest() {
	const instance = clerk.state.created.at(-1);
	if (!instance) throw new Error('no Clerk instance was constructed');
	return instance;
}

function user(overrides: Partial<FakeClerkUser> = {}): FakeClerkUser {
	return {
		id: 'user_123',
		fullName: 'Alex Rivera',
		username: null,
		firstName: 'Alex',
		primaryEmailAddress: { emailAddress: 'alex@example.com' },
		...overrides
	};
}

/**
 * Resolve the module graph once, outside any timed test.
 *
 * Every test below re-imports the module to clear its cached Clerk instance. The first of
 * those imports pays for resolving the whole graph, which under a full parallel run is slow
 * enough to blow the default five-second timeout — so whichever test happened to run first
 * failed, intermittently and for a reason that had nothing to do with it. Later imports hit
 * Vitest's transform cache and are cheap.
 */
beforeAll(async () => {
	await loadModule();
});

beforeEach(() => {
	clerk.state.created = [];
	clerk.state.loadRejects = false;
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe('isAuthConfigured', () => {
	it('is false in a build with no publishable key', async () => {
		const { isAuthConfigured } = await loadModule('');
		expect(isAuthConfigured()).toBe(false);
	});

	it('is true once a key is baked in', async () => {
		const { isAuthConfigured } = await loadModule();
		expect(isAuthConfigured()).toBe(true);
	});
});

describe('auth.user', () => {
	// Rendering "signed out" while Clerk is still loading flashes a sign-in prompt at
	// somebody who is already signed in. `undefined` is what lets a caller wait instead.
	it('is undefined until something asks Clerk', async () => {
		const { auth } = await loadModule();
		expect(auth.user).toBeUndefined();
	});

	it('settles to null, not undefined, when auth is not configured', async () => {
		const { auth, loadAuth } = await loadModule('');

		await loadAuth();

		expect(auth.user).toBeNull();
	});

	it('settles to null when Clerk loads with nobody signed in', async () => {
		const { auth, loadAuth } = await loadModule();

		await loadAuth();

		expect(auth.user).toBeNull();
	});
});

describe('loadAuth', () => {
	it('never constructs Clerk without a publishable key', async () => {
		const { loadAuth } = await loadModule('');

		expect(await loadAuth()).toBeNull();
		expect(clerk.state.created).toHaveLength(0);
	});

	it('builds one instance and hands the same one to every caller', async () => {
		const { loadAuth } = await loadModule();

		const [first, second] = await Promise.all([loadAuth(), loadAuth()]);
		const third = await loadAuth();

		expect(clerk.state.created).toHaveLength(1);
		expect(first).toBe(second);
		expect(third).toBe(first);
	});

	it('passes the publishable key through to Clerk', async () => {
		const { loadAuth } = await loadModule('pk_live_xyz');
		await loadAuth();
		expect(latest().publishableKey).toBe('pk_live_xyz');
	});

	it('reports null and clears the user when Clerk cannot be loaded', async () => {
		clerk.state.loadRejects = true;
		const { auth, loadAuth } = await loadModule();

		expect(await loadAuth()).toBeNull();
		expect(auth.user).toBeNull();
	});

	it('lets a later call retry, rather than caching the failure forever', async () => {
		clerk.state.loadRejects = true;
		const { loadAuth } = await loadModule();
		expect(await loadAuth()).toBeNull();

		clerk.state.loadRejects = false;
		const recovered = await loadAuth();

		expect(recovered).not.toBeNull();
		expect(clerk.state.created).toHaveLength(2);
	});
});

describe('the signed-in identity', () => {
	/** Load, put a user on the instance, and let Clerk's listener report it. */
	async function signIn(overrides: Partial<FakeClerkUser> = {}) {
		const module = await loadModule();
		await module.loadAuth();
		latest().user = user(overrides);
		latest().emit();
		return module;
	}

	it('is picked up from Clerk without anyone polling for it', async () => {
		const { auth } = await signIn();
		expect(auth.user).toEqual({ id: 'user_123', name: 'Alex Rivera', givenName: 'Alex' });
	});

	it('clears again when Clerk reports the session gone', async () => {
		const { auth } = await signIn();
		latest().user = null;
		latest().emit();

		expect(auth.user).toBeNull();
	});

	// Sign-up is open and email alone is a valid first factor, so a user is not guaranteed
	// to have a name at all. Each step is what remains when the one before it is absent.
	it.each([
		['the full name', {}, 'Alex Rivera'],
		['the username', { fullName: null, username: 'ariv' }, 'ariv'],
		['the email local part', { fullName: null, username: null }, 'alex'],
		[
			'an empty string when the user has nothing at all',
			{ fullName: null, username: null, primaryEmailAddress: null },
			''
		]
	])('falls back to %s', async (_label, overrides, expected) => {
		const { auth } = await signIn(overrides);
		expect(auth.user?.name).toBe(expected);
	});

	it('uses the first name for the greeting, falling back to the display name', async () => {
		const withFirst = await signIn({ firstName: 'Alex', fullName: 'Alex Rivera' });
		expect(withFirst.auth.user?.givenName).toBe('Alex');

		const withoutFirst = await signIn({ firstName: null, fullName: 'Alex Rivera' });
		expect(withoutFirst.auth.user?.givenName).toBe('Alex Rivera');
	});

	it('truncates a name to what the backend will accept', async () => {
		const { auth } = await signIn({ fullName: 'A'.repeat(80) });
		expect(auth.user?.name).toHaveLength(50);
	});
});

describe('getApiToken', () => {
	// API Gateway validates `aud` and matches `authorization_scopes` against `scope`. Clerk's
	// default session token carries neither, so this template is the only accepted shape —
	// minting the wrong one fails every authenticated request at the gateway.
	it('mints from the apigw template, not the default session token', async () => {
		const { loadAuth, getApiToken } = await loadModule();
		await loadAuth();
		const getToken = vi.fn(async () => 'signed-jwt');
		latest().session = { getToken };

		expect(await getApiToken()).toBe('signed-jwt');
		expect(getToken).toHaveBeenCalledWith({ template: 'apigw' });
	});

	it('reports no token when nobody is signed in, without asking for one', async () => {
		const { loadAuth, getApiToken } = await loadModule();
		await loadAuth();

		expect(await getApiToken()).toBeNull();
		// Asserting the path, not just the value: without the `!clerk?.session` guard this
		// still answers null, because reaching through a null session throws and the catch
		// below turns that into null. The guard would then be free to delete.
		expect(console.error).not.toHaveBeenCalled();
	});

	it('reports no token when Clerk itself is unavailable', async () => {
		const { getApiToken } = await loadModule('');
		expect(await getApiToken()).toBeNull();
	});

	it('reports no token rather than throwing when minting fails', async () => {
		const { loadAuth, getApiToken } = await loadModule();
		await loadAuth();
		latest().session = {
			getToken: vi.fn(async () => {
				throw new Error('network');
			})
		};

		expect(await getApiToken()).toBeNull();
	});
});

describe('signOut', () => {
	it('ends the Clerk session and clears the user', async () => {
		const { auth, loadAuth, signOut } = await loadModule();
		await loadAuth();
		latest().user = user();
		latest().emit();

		await signOut();

		expect(latest().signOut).toHaveBeenCalledOnce();
		expect(auth.user).toBeNull();
	});

	it('still clears the user when there is no Clerk to sign out of', async () => {
		const { auth, signOut } = await loadModule('');

		await signOut();

		expect(auth.user).toBeNull();
	});
});

describe('mountSignIn', () => {
	const node = () => document.createElement('div');

	it('says so when the build has no auth configured', async () => {
		const { mountSignIn } = await loadModule('');
		expect(await mountSignIn(node())).toBe('Sign-in is not configured.');
	});

	it('says so when Clerk cannot be brought up', async () => {
		clerk.state.loadRejects = true;
		const { mountSignIn } = await loadModule();
		expect(await mountSignIn(node())).toBe('Sign-in is unavailable right now.');
	});

	it('mounts with sign-up in play, and reports no error', async () => {
		// Without withSignUp, Clerk's "Sign up" link leaves for its separately-hosted Account
		// Portal — a different origin, with none of this app's appearance applied.
		const { mountSignIn } = await loadModule();
		const target = node();

		expect(await mountSignIn(target)).toBe('');
		expect(latest().mountSignIn).toHaveBeenCalledWith(target, { withSignUp: true });
	});

});

// These belong to what loadAuth hands Clerk at startup, not to mounting: they never call
// mountSignIn, and filing them under it made that block look broader than it is.
describe('the options Clerk is loaded with', () => {
	it('keeps the visitor on the page they opened the modal from', async () => {
		// Left unset, Clerk sends them to an instance-level Home URL that serves nothing on
		// the production Frontend API domain.
		const { loadAuth } = await loadModule();
		await loadAuth();

		expect(latest().loadOptions).toMatchObject({
			signInFallbackRedirectUrl: window.location.href,
			signUpFallbackRedirectUrl: window.location.href
		});
	});

	it('hands Clerk the prebuilt UI bundle it needs to mount components', async () => {
		// clerk-js 6 ships the prebuilt components separately; without this, mountSignIn
		// throws "Clerk was not loaded with Ui components".
		const { loadAuth } = await loadModule();
		await loadAuth();

		expect(latest().loadOptions?.ui).toEqual({ fake: 'ui-bundle' });
	});
});

describe('unmountSignIn', () => {
	it('does nothing when nothing was ever mounted', async () => {
		const { unmountSignIn } = await loadModule();
		expect(() => unmountSignIn(document.createElement('div'))).not.toThrow();
		expect(clerk.state.created).toHaveLength(0);
	});

	it('tears down the mounted component', async () => {
		const { loadAuth, unmountSignIn } = await loadModule();
		await loadAuth();
		const target = document.createElement('div');

		unmountSignIn(target);
		await vi.waitFor(() => expect(latest().unmountSignIn).toHaveBeenCalledWith(target));
	});
});
