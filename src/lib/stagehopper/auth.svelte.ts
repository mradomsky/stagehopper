/**
 * @file The signed-in identity, owned by Clerk.
 *
 * The app builds with `adapter-static` and `src/routes/+layout.ts` sets `prerender = true`,
 * so every module here is *also* evaluated in Node at build time. Clerk reaches for `window`
 * the moment it is constructed, which is why nothing below runs unless `browser` is true.
 * Getting that wrong breaks the build rather than the runtime — the safer failure, and the
 * more confusing one, so it is worth stating out loud.
 *
 * That build-time constraint is also why this is `@clerk/clerk-js` and not the official
 * SvelteKit integration: there is no server, so `hooks.server.ts` would never run.
 *
 * There is no token cache here. Clerk session tokens are short-lived and the SDK refreshes
 * them on its own, so {@link getApiToken} mints one per request. That is what replaced the
 * expiry arithmetic, the One Tap silent refresh and the in-flight-refresh dedupe this file
 * used to hold.
 */

import { browser } from '$app/environment';
import type { Clerk } from '@clerk/clerk-js';
import { truncateName } from './selections.js';

/**
 * The Clerk JWT template that mints API tokens, rather than the default session token.
 *
 * API Gateway's JWT authorizer validates `aud` against a configured audience and matches
 * `authorization_scopes` against `scope`. Clerk's default session token carries neither
 * claim, so a template is not a preference here — it is the only shape the gateway accepts.
 */
const API_TOKEN_TEMPLATE = 'apigw';

/** The signed-in user, as much of them as the UI needs. */
export interface AuthUser {
	/** Clerk's user id. Every row the backend writes is keyed `clerk:${id}`. */
	id: string;
	name: string;
	givenName: string;
}

/**
 * The current user: `undefined` while Clerk is still loading, `null` once it has said
 * nobody is signed in.
 *
 * The distinction is load-bearing. Rendering "signed out" during the load flashes a sign-in
 * prompt at someone who is already signed in, which is exactly the flicker #96 fixed for
 * the old flow.
 */
export const auth = $state<{ user: AuthUser | null | undefined }>({
	user: browser ? undefined : null
});

/** The participant key the backend writes under, or null when signed out. */
export function participantKey(): string | null {
	return auth.user ? `clerk:${auth.user.id}` : null;
}

/** The publishable key, injected at build time. Public by design — it identifies, it doesn't authorize. */
function publishableKey(): string {
	return import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? '';
}

/** Whether auth is configured at all. False in a build with no publishable key. */
export function isAuthConfigured(): boolean {
	return publishableKey().length > 0;
}

let clerkPromise: Promise<Clerk | null> | null = null;

/**
 * The loaded Clerk instance, or null when it can't exist here (prerender, no key, load
 * failure). Idempotent: the whole app shares one instance and one load.
 */
export function loadAuth(): Promise<Clerk | null> {
	if (!browser || !isAuthConfigured()) {
		auth.user = null;
		return Promise.resolve(null);
	}
	if (!clerkPromise) {
		clerkPromise = startClerk().catch((err) => {
			console.error('Clerk failed to load:', err);
			// Let a later call try again rather than caching the rejection forever.
			clerkPromise = null;
			auth.user = null;
			return null;
		});
	}
	return clerkPromise;
}

async function startClerk(): Promise<Clerk> {
	// The prebuilt components ship separately from the core since clerk-js 6: `mountSignIn`
	// throws "Clerk was not loaded with Ui components" unless the bundle is handed to
	// `load()`. Taken from npm rather than Clerk's CDN script, so the whole app stays
	// self-contained and nothing has to be allowed through a future CSP.
	const [{ Clerk }, { ui }, { dark }] = await Promise.all([
		import('@clerk/clerk-js'),
		import('@clerk/ui'),
		import('@clerk/ui/themes')
	]);
	const clerk = new Clerk(publishableKey());
	// Left unset, Clerk falls back to an instance-level Home URL that isn't configured for
	// the production Frontend API domain, and lands the user on
	// https://clerk.stagehopper.radomskyi.com/ — which serves nothing — after sign-up.
	// Pinning both explicitly to the current page keeps the user where they opened the modal.
	await clerk.load({
		ui,
		signInFallbackRedirectUrl: window.location.href,
		signUpFallbackRedirectUrl: window.location.href,
		// Matches the app's own dark chrome (see app.css) now that SignInModal no longer
		// wraps this in a card of its own — Clerk's card is the only one on screen.
		appearance: {
			theme: dark,
			variables: {
				colorPrimary: '#e74c3c',
				// The dark theme's own default is black-on-white; without this override it stays
				// black even after colorPrimary turns the button red, reading as barely-there text.
				colorPrimaryForeground: '#ffffff',
				colorBackground: '#232323',
				colorInput: '#333333',
				colorBorder: '#555555',
				colorForeground: '#fffaf0',
				colorMutedForeground: '#aaaaaa'
			}
		}
	});
	syncUser(clerk);
	// Sign-in and sign-out happen inside Clerk's own components, so this listener is how
	// the rest of the app finds out — there is no callback to thread through.
	clerk.addListener(() => syncUser(clerk));
	return clerk;
}

/**
 * A name to show. Clerk allows sign-up without one (sign-up is open, and email is a valid
 * first factor), so this falls back through what a user is guaranteed to have.
 */
function displayName(user: { fullName: string | null; username: string | null; primaryEmailAddress: { emailAddress: string } | null }): string {
	const email = user.primaryEmailAddress?.emailAddress ?? '';
	return truncateName(user.fullName || user.username || email.split('@')[0] || '');
}

function syncUser(clerk: Clerk): void {
	const user = clerk.user;
	auth.user = user
		? {
				id: user.id,
				name: displayName(user),
				givenName: truncateName(user.firstName ?? '') || displayName(user)
			}
		: null;
}

/**
 * A bearer token for one API call, or null when nobody is signed in.
 *
 * Called per request rather than cached: the template's tokens live 60 seconds, and the
 * SDK holds the refresh. A caller that gets null should prompt for sign-in.
 */
export async function getApiToken(): Promise<string | null> {
	const clerk = await loadAuth();
	if (!clerk?.session) return null;
	try {
		return await clerk.session.getToken({ template: API_TOKEN_TEMPLATE });
	} catch (err) {
		console.error('Could not mint an API token:', err);
		return null;
	}
}

/** End the session. The listener clears {@link auth} once Clerk confirms. */
export async function signOut(): Promise<void> {
	const clerk = await loadAuth();
	await clerk?.signOut();
	auth.user = null;
}

/**
 * Render Clerk's prebuilt sign-in (and sign-up, and password reset) into `node`.
 *
 * Prebuilt rather than headless: sign-up stays open here because this is a room-sharing app
 * for friends, so these are real flows worth not hand-rolling. Returns a message to display
 * when Clerk can't be brought up at all, or '' on success.
 */
export async function mountSignIn(node: HTMLDivElement): Promise<string> {
	if (!isAuthConfigured()) return 'Sign-in is not configured.';
	const clerk = await loadAuth();
	if (!clerk) return 'Sign-in is unavailable right now.';
	clerk.mountSignIn(node);
	return '';
}

/** Tear down a mounted sign-in. Safe to call when nothing was mounted. */
export function unmountSignIn(node: HTMLDivElement): void {
	if (!browser || !clerkPromise) return;
	void clerkPromise.then((clerk) => clerk?.unmountSignIn(node));
}
