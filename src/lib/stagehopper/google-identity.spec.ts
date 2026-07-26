import { describe, expect, it } from 'vitest';
import { googleSignInErrorMessage, parseGoogleIdTokenClaims } from './google-identity.js';

/** Build an unsigned token whose payload is what the browser would decode. */
function tokenWithPayload(payload: unknown): string {
	const base64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_');
	return `header.${base64.replace(/=+$/, '')}.signature`;
}

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
