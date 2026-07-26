/**
 * @file Google Identity Services bootstrapping, shared by every sign-in surface.
 */

import { truncateName } from './selections.js';

const GSI_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

/** The slice of `google.accounts.id` this app uses. */
export interface GoogleAccountsApi {
	initialize(config: {
		client_id: string;
		callback: (response: GoogleCredentialResponse) => void;
		auto_select?: boolean;
		use_fedcm_for_prompt?: boolean;
	}): void;
	renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
	prompt(): void;
}

export interface GoogleCredentialResponse {
	credential?: string;
}

export interface GoogleIdTokenClaims {
	sub: string;
	name: string;
	givenName: string;
}

/** Load the Google Identity Services script once; safe to call repeatedly. */
async function loadGoogleScript(): Promise<boolean> {
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

function getGoogleAccountsApi(): GoogleAccountsApi | null {
	if (typeof window === 'undefined') return null;
	const google = (window as unknown as { google?: { accounts?: { id?: GoogleAccountsApi } } })
		.google;
	return google?.accounts?.id ?? null;
}

/**
 * Decode (not verify) a Google ID token's payload for optimistic client-side use.
 * The server independently verifies the token before trusting any of this.
 */
export function parseGoogleIdTokenClaims(token: string): GoogleIdTokenClaims | null {
	try {
		const payloadPart = token.split('.')[1];
		if (!payloadPart) return null;
		const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
		const paddedBase64 = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
		const payload: unknown = JSON.parse(atob(paddedBase64));
		const claims = payload as { sub?: unknown; name?: unknown; given_name?: unknown };
		if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
			return null;
		}
		return {
			sub: claims.sub,
			name: typeof claims.name === 'string' ? truncateName(claims.name) : '',
			givenName: typeof claims.given_name === 'string' ? truncateName(claims.given_name) : ''
		};
	} catch {
		return null;
	}
}

export interface GoogleSignInOptions {
	clientId: string;
	onCredential: (response: GoogleCredentialResponse) => void;
	/** Where to render the "Continue with Google" button, when there is one. */
	buttonEl?: HTMLElement | null;
}

export type GoogleSignInError = 'no-client-id' | 'script-failed' | 'unavailable' | null;

/**
 * Bring up Google sign-in: load the script, wire the callback, render the button and
 * show the One Tap prompt. Returns null on success or a failure reason to display.
 */
export async function initGoogleSignIn(
	options: GoogleSignInOptions
): Promise<GoogleSignInError> {
	if (!options.clientId) return 'no-client-id';

	if (!(await loadGoogleScript())) return 'script-failed';

	const accountsApi = getGoogleAccountsApi();
	if (!accountsApi) return 'unavailable';

	accountsApi.initialize({
		client_id: options.clientId,
		callback: options.onCredential,
		auto_select: true,
		use_fedcm_for_prompt: true
	});

	if (options.buttonEl) {
		options.buttonEl.innerHTML = '';
		accountsApi.renderButton(options.buttonEl, {
			theme: 'outline',
			size: 'large',
			shape: 'pill',
			text: 'continue_with',
			width: 280
		});
	}

	accountsApi.prompt();
	return null;
}

/** The configured Google OAuth client id, empty when auth is not configured. */
export function getGoogleClientId(): string {
	return import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
}

/** Human-readable message for a sign-in failure. */
export function googleSignInErrorMessage(error: GoogleSignInError): string {
	switch (error) {
		case 'script-failed':
			return 'Google auth script failed to load.';
		case 'no-client-id':
		case 'unavailable':
			return 'Google auth is unavailable.';
		default:
			return '';
	}
}
