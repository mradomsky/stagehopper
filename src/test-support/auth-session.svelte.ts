/**
 * @file A controllable stand-in for the Clerk-backed session, for component tests.
 *
 * Components read `auth.user` reactively, so a plain object in a `vi.mock` factory would
 * never re-render them. This lives in a `.svelte.ts` module so the state is a real rune,
 * and a mock factory can hand the same object back as `auth`.
 *
 * `undefined` means "Clerk has not resolved yet" — the state that keeps the header quiet
 * instead of flashing a name it may be about to retract.
 */

export interface TestAuthUser {
	id: string;
	name: string;
	givenName: string;
}

export const session = $state<{ user: TestAuthUser | null | undefined }>({ user: undefined });

/** Sign a user in, as Clerk would once its component completes a flow. */
export function setSessionUser(
	user: TestAuthUser | null = { id: '123', name: 'Alex Example', givenName: 'Alex' }
): void {
	session.user = user;
}

/**
 * Back to "Clerk has not answered yet". A separate function rather than
 * `setSessionUser(undefined)`, which would silently hit the default parameter and sign
 * someone in instead.
 */
export function setSessionPending(): void {
	session.user = undefined;
}

/** Back to "resolved, nobody signed in" — the ordinary state for a fresh visitor. */
export function resetSession(): void {
	session.user = null;
}

/**
 * The module shape `$lib/stagehopper/auth.svelte.js` exposes, backed by {@link session}.
 * A token exists exactly when a user does, which is the only rule `api.ts` depends on.
 */
export function mockAuthModule() {
	return {
		auth: session,
		loadAuth: async () => null,
		isAuthConfigured: () => true,
		participantKey: () => (session.user ? `clerk:${session.user.id}` : null),
		getApiToken: async () => (session.user ? 'clerk-jwt' : null),
		signOut: async () => {
			session.user = null;
		},
		mountSignIn: async () => '',
		unmountSignIn: () => {}
	};
}
