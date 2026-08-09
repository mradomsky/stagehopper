/**
 * @file Keeping the signed-in Google identity usable.
 *
 * Google ID tokens live ~1 hour. The app caches one in localStorage, so after an hour
 * every authenticated call would fail with a 401 and the admin surface would bounce the
 * user home. {@link ensureFreshGoogleAuth} closes that gap: it hands back the cached
 * identity while it's still valid, and silently mints a new token via Google Identity
 * Services when it isn't — falling back to "signed out" only when even that can't.
 */

import {
	getGoogleClientId,
	isGoogleIdTokenExpired,
	parseGoogleIdTokenClaims,
	refreshGoogleIdToken
} from './google-identity.js';
import { clearGoogleAuth, loadGoogleAuth, saveGoogleAuth } from './storage.js';
import type { GoogleIdentity } from './types.js';

/**
 * Return a Google identity whose token is good to send right now, refreshing it first if
 * the cached one has expired. Returns null when the user isn't signed in and can't be
 * silently re-authenticated — callers treat that as "prompt for sign-in".
 *
 * On a successful refresh the new token is persisted, so subsequent calls this session
 * reuse it until it too nears expiry.
 */
/** Dedupes concurrent refreshes so parallel admin calls trigger at most one One Tap. */
let inFlightRefresh: Promise<GoogleIdentity | null> | null = null;

export async function ensureFreshGoogleAuth(): Promise<GoogleIdentity | null> {
	const current = loadGoogleAuth();
	if (current && !isGoogleIdTokenExpired(current.idToken)) return current;

	if (!inFlightRefresh) {
		inFlightRefresh = refreshIdentity(current).finally(() => {
			inFlightRefresh = null;
		});
	}
	return inFlightRefresh;
}

async function refreshIdentity(current: GoogleIdentity | null): Promise<GoogleIdentity | null> {
	const token = await refreshGoogleIdToken(getGoogleClientId());
	const claims = token ? parseGoogleIdTokenClaims(token) : null;
	if (!token || !claims) {
		// Couldn't refresh: drop the stale token so guards see a clean signed-out state.
		if (current) clearGoogleAuth();
		return null;
	}

	const identity: GoogleIdentity = {
		idToken: token,
		sub: claims.sub,
		name: claims.name,
		givenName: claims.givenName
	};
	saveGoogleAuth(identity);
	return identity;
}
