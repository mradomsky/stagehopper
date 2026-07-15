/**
 * @file Google Identity Services bootstrapping, shared by the root and room pages.
 */

const GSI_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

/** Load the Google Identity Services script once; safe to call repeatedly. */
export async function loadGoogleScript() {
	if (typeof document === 'undefined') return false;
	if (document.querySelector('script[data-stagehopper-google-auth="1"]')) {
		return true;
	}

	return new Promise((resolve) => {
		const script = document.createElement('script');
		script.src = GSI_SCRIPT_SRC;
		script.async = true;
		script.defer = true;
		script.dataset.stagehopperGoogleAuth = '1';
		script.onload = () => resolve(true);
		script.onerror = () => resolve(false);
		document.head.appendChild(script);
	});
}

/** @returns {{ initialize: Function, renderButton: Function, prompt: Function } | null} */
export function getGoogleAccountsApi() {
	if (typeof window === 'undefined') return null;
	const google = /** @type {any} */ (window).google;
	if (!google?.accounts?.id) return null;
	return google.accounts.id;
}

/**
 * @param {string} value
 * @returns {string}
 */
function truncateName(value) {
	return value.trim().slice(0, 50);
}

/**
 * Decode (not verify) a Google ID token's payload for optimistic client-side use.
 * The server independently verifies the token before trusting any of this.
 * @param {string} token
 * @returns {{ sub: string; name: string; givenName: string } | null}
 */
export function parseGoogleIdTokenClaims(token) {
	try {
		const payloadPart = token.split('.')[1];
		if (!payloadPart) return null;
		const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
		const paddedBase64 = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
		const json = atob(paddedBase64);
		const payload = JSON.parse(json);
		if (typeof payload?.sub !== 'string' || payload.sub.length === 0) {
			return null;
		}
		return {
			sub: payload.sub,
			name: typeof payload?.name === 'string' ? truncateName(payload.name) : '',
			givenName: typeof payload?.given_name === 'string' ? truncateName(payload.given_name) : ''
		};
	} catch {
		return null;
	}
}
