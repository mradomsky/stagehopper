import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	getGoogleIdTokenExpiry,
	googleSignInErrorMessage,
	initGoogleSignIn,
	isGoogleIdTokenExpired,
	parseGoogleIdTokenClaims,
	refreshGoogleIdToken
} from './google-identity.js';

/** Build an unsigned token whose payload is what the browser would decode. */
function tokenWithPayload(payload: unknown): string {
	const base64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_');
	return `header.${base64.replace(/=+$/, '')}.signature`;
}

const GSI_SELECTOR = 'script[data-stagehopper-google-auth="1"]';

const initialize = vi.fn();
const renderButton = vi.fn();
const prompt = vi.fn();

/** Publish the `google.accounts.id` API the real script would install. */
function installGoogleApi() {
	(window as unknown as { google?: unknown }).google = {
		accounts: { id: { initialize, renderButton, prompt } }
	};
}

function removeGoogleApi() {
	delete (window as unknown as { google?: unknown }).google;
}

/**
 * jsdom never fetches the injected script, so its load event would never fire and
 * the promise would hang. Let the element into the DOM (the once-only check reads it
 * back) but settle it here.
 */
function interceptScriptLoad(outcome: 'load' | 'error') {
	const append = document.head.appendChild.bind(document.head);
	return vi.spyOn(document.head, 'appendChild').mockImplementation((node) => {
		const appended = append(node);
		if (appended instanceof HTMLScriptElement) {
			queueMicrotask(() => {
				if (outcome === 'load') {
					installGoogleApi();
					appended.onload?.(new Event('load'));
				} else {
					appended.onerror?.(new Event('error'));
				}
			});
		}
		return appended;
	});
}

describe('initGoogleSignIn', () => {
	beforeEach(() => {
		initialize.mockReset();
		renderButton.mockReset();
		prompt.mockReset();
		removeGoogleApi();
		document.querySelectorAll(GSI_SELECTOR).forEach((script) => script.remove());
	});

	afterEach(() => {
		vi.restoreAllMocks();
		removeGoogleApi();
	});

	it('refuses to start when no client id is configured', async () => {
		const appendChild = interceptScriptLoad('load');

		expect(await initGoogleSignIn({ clientId: '', onCredential: vi.fn() })).toBe('no-client-id');
		expect(appendChild).not.toHaveBeenCalled();
	});

	it('loads the Google script and shows the prompt', async () => {
		interceptScriptLoad('load');

		expect(await initGoogleSignIn({ clientId: 'client-1', onCredential: vi.fn() })).toBeNull();

		const script = document.querySelector(GSI_SELECTOR) as HTMLScriptElement;
		expect(script.src).toBe('https://accounts.google.com/gsi/client');
		expect(script.async).toBe(true);
		expect(script.defer).toBe(true);
		expect(prompt).toHaveBeenCalledOnce();
	});

	it('initializes with the client id and the caller’s callback', async () => {
		interceptScriptLoad('load');
		const onCredential = vi.fn();

		await initGoogleSignIn({ clientId: 'client-1', onCredential });

		expect(initialize).toHaveBeenCalledWith({
			client_id: 'client-1',
			callback: onCredential,
			auto_select: true,
			use_fedcm_for_prompt: true
		});
	});

	it('loads the script only once across repeated sign-in attempts', async () => {
		interceptScriptLoad('load');

		await initGoogleSignIn({ clientId: 'client-1', onCredential: vi.fn() });
		await initGoogleSignIn({ clientId: 'client-1', onCredential: vi.fn() });

		expect(document.querySelectorAll(GSI_SELECTOR)).toHaveLength(1);
		// Still re-initialized, so the second caller's callback wins.
		expect(initialize).toHaveBeenCalledTimes(2);
		expect(prompt).toHaveBeenCalledTimes(2);
	});

	it('reports a script that fails to load', async () => {
		interceptScriptLoad('error');

		expect(await initGoogleSignIn({ clientId: 'client-1', onCredential: vi.fn() })).toBe(
			'script-failed'
		);
		expect(initialize).not.toHaveBeenCalled();
	});

	it('reports a script that loads without installing the API', async () => {
		const append = document.head.appendChild.bind(document.head);
		vi.spyOn(document.head, 'appendChild').mockImplementation((node) => {
			const appended = append(node);
			// Loads, but never publishes google.accounts.id — e.g. blocked by an extension.
			if (appended instanceof HTMLScriptElement) {
				queueMicrotask(() => appended.onload?.(new Event('load')));
			}
			return appended;
		});

		expect(await initGoogleSignIn({ clientId: 'client-1', onCredential: vi.fn() })).toBe(
			'unavailable'
		);
		expect(prompt).not.toHaveBeenCalled();
	});

	it('renders the button into the host element the caller supplied', async () => {
		interceptScriptLoad('load');
		const buttonEl = document.createElement('div');

		await initGoogleSignIn({ clientId: 'client-1', onCredential: vi.fn(), buttonEl });

		expect(renderButton).toHaveBeenCalledWith(buttonEl, expect.objectContaining({ theme: 'outline' }));
	});

	it('clears the host before rendering, so re-opening never stacks two buttons', async () => {
		interceptScriptLoad('load');
		const buttonEl = document.createElement('div');
		buttonEl.innerHTML = '<span>previous button</span>';

		await initGoogleSignIn({ clientId: 'client-1', onCredential: vi.fn(), buttonEl });

		expect(buttonEl.innerHTML).toBe('');
	});

	it('still prompts when there is no host element to render into', async () => {
		interceptScriptLoad('load');

		await initGoogleSignIn({ clientId: 'client-1', onCredential: vi.fn(), buttonEl: null });

		expect(renderButton).not.toHaveBeenCalled();
		expect(prompt).toHaveBeenCalledOnce();
	});

	it('skips loading the script when the API is already present', async () => {
		installGoogleApi();
		const alreadyLoaded = document.createElement('script');
		alreadyLoaded.dataset.stagehopperGoogleAuth = '1';
		document.head.appendChild(alreadyLoaded);
		const appendChild = interceptScriptLoad('load');

		expect(await initGoogleSignIn({ clientId: 'client-1', onCredential: vi.fn() })).toBeNull();
		expect(appendChild).not.toHaveBeenCalled();
	});
});

describe('parseGoogleIdTokenClaims', () => {
	it('extracts sub, name and given name', () => {
		const token = tokenWithPayload({
			sub: '1234567890',
			name: 'Alex Example',
			given_name: 'Alex'
		});

		expect(parseGoogleIdTokenClaims(token)).toEqual({
			sub: '1234567890',
			name: 'Alex Example',
			givenName: 'Alex'
		});
	});

	it('defaults missing name claims to empty strings', () => {
		expect(parseGoogleIdTokenClaims(tokenWithPayload({ sub: '1' }))).toEqual({
			sub: '1',
			name: '',
			givenName: ''
		});
	});

	it('truncates over-long names to what the backend accepts', () => {
		const claims = parseGoogleIdTokenClaims(
			tokenWithPayload({ sub: '1', name: 'x'.repeat(80) })
		);
		expect(claims?.name).toHaveLength(50);
	});

	it('rejects a token with no subject', () => {
		expect(parseGoogleIdTokenClaims(tokenWithPayload({ name: 'Alex' }))).toBeNull();
	});

	it('rejects a malformed token', () => {
		expect(parseGoogleIdTokenClaims('not-a-token')).toBeNull();
		expect(parseGoogleIdTokenClaims('')).toBeNull();
		expect(parseGoogleIdTokenClaims('a.!!!.c')).toBeNull();
	});
});

describe('token expiry', () => {
	it('reads the exp claim as epoch milliseconds', () => {
		expect(getGoogleIdTokenExpiry(tokenWithPayload({ sub: '1', exp: 1_700_000_000 }))).toBe(
			1_700_000_000_000
		);
	});

	it('returns null when exp is missing or the token is malformed', () => {
		expect(getGoogleIdTokenExpiry(tokenWithPayload({ sub: '1' }))).toBeNull();
		expect(getGoogleIdTokenExpiry('not-a-token')).toBeNull();
	});

	it('is not expired well before exp, allowing for skew', () => {
		const token = tokenWithPayload({ sub: '1', exp: 2000 });
		expect(isGoogleIdTokenExpired(token, 1000 * 1000, 60_000)).toBe(false);
	});

	it('is expired once inside the skew window before exp', () => {
		const token = tokenWithPayload({ sub: '1', exp: 2000 });
		// now = 1,950,000ms, exp = 2,000,000ms, skew = 60,000ms → 1.95M >= 1.94M.
		expect(isGoogleIdTokenExpired(token, 1_950_000, 60_000)).toBe(true);
	});

	it('is expired past exp and for tokens with no readable exp', () => {
		expect(isGoogleIdTokenExpired(tokenWithPayload({ sub: '1', exp: 100 }), 200_000)).toBe(true);
		expect(isGoogleIdTokenExpired(tokenWithPayload({ sub: '1' }), 0)).toBe(true);
		expect(isGoogleIdTokenExpired('garbage', 0)).toBe(true);
	});
});

describe('refreshGoogleIdToken', () => {
	let capturedCallback: ((response: { credential?: string }) => void) | null = null;

	beforeEach(() => {
		initialize.mockReset();
		prompt.mockReset();
		removeGoogleApi();
		document.querySelectorAll(GSI_SELECTOR).forEach((script) => script.remove());
		capturedCallback = null;
		initialize.mockImplementation((cfg: { callback: (r: { credential?: string }) => void }) => {
			capturedCallback = cfg.callback;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		removeGoogleApi();
	});

	/** Pretend the script is already loaded so the flow reaches initialize/prompt. */
	function withGoogleReady() {
		installGoogleApi();
		const script = document.createElement('script');
		script.dataset.stagehopperGoogleAuth = '1';
		document.head.appendChild(script);
	}

	it('returns the credential the One Tap callback delivers', async () => {
		withGoogleReady();
		prompt.mockImplementation(() => capturedCallback?.({ credential: 'fresh-token' }));

		await expect(refreshGoogleIdToken('client-1')).resolves.toBe('fresh-token');
		expect(initialize).toHaveBeenCalledWith(
			expect.objectContaining({ client_id: 'client-1', auto_select: true })
		);
	});

	it('returns null without touching Google when no client id is set', async () => {
		withGoogleReady();
		await expect(refreshGoogleIdToken('')).resolves.toBeNull();
		expect(prompt).not.toHaveBeenCalled();
	});

	it('resolves null when the prompt never calls back within the timeout', async () => {
		vi.useFakeTimers();
		withGoogleReady();
		prompt.mockImplementation(() => {}); // no credential ever arrives

		const pending = refreshGoogleIdToken('client-1', 5000);
		await vi.advanceTimersByTimeAsync(5000);
		await expect(pending).resolves.toBeNull();
		vi.useRealTimers();
	});

	it('resolves null when the prompt throws', async () => {
		withGoogleReady();
		prompt.mockImplementation(() => {
			throw new Error('prompt blew up');
		});
		await expect(refreshGoogleIdToken('client-1')).resolves.toBeNull();
	});
});

describe('googleSignInErrorMessage', () => {
	it('describes each failure mode', () => {
		expect(googleSignInErrorMessage('script-failed')).toMatch(/failed to load/i);
		expect(googleSignInErrorMessage('unavailable')).toMatch(/unavailable/i);
		expect(googleSignInErrorMessage('no-client-id')).toMatch(/unavailable/i);
	});

	it('is empty when there is no failure', () => {
		expect(googleSignInErrorMessage(null)).toBe('');
	});
});
