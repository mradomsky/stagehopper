import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifyIdToken = vi.fn();

vi.mock('google-auth-library', () => ({
	OAuth2Client: vi.fn().mockImplementation(() => ({ verifyIdToken }))
}));

describe('resolveGoogleIdentity', () => {
	beforeEach(() => {
		vi.resetModules();
		verifyIdToken.mockReset();
		process.env.GOOGLE_CLIENT_ID = 'test-client-id';
	});

	afterEach(() => {
		delete process.env.GOOGLE_CLIENT_ID;
	});

	it('resolves a valid google id token to a participant key', async () => {
		verifyIdToken.mockResolvedValue({
			getPayload: () => ({ sub: '1234567890', name: 'Alex Example' })
		});
		const { resolveGoogleIdentity } = await import('./index.mjs');

		expect(await resolveGoogleIdentity('valid-token')).toEqual({
			ok: true,
			participantKey: 'google:1234567890',
			name: 'Alex Example'
		});
	});

	it('prefers the client-supplied display name over the google profile name', async () => {
		verifyIdToken.mockResolvedValue({
			getPayload: () => ({ sub: '1234567890', name: 'Alex Example' })
		});
		const { resolveGoogleIdentity } = await import('./index.mjs');

		expect(await resolveGoogleIdentity('valid-token', 'Max')).toEqual({
			ok: true,
			participantKey: 'google:1234567890',
			name: 'Max'
		});
	});

	it('falls back to the google profile name when no client name is given', async () => {
		verifyIdToken.mockResolvedValue({
			getPayload: () => ({ sub: '1234567890', name: 'Alex Example' })
		});
		const { resolveGoogleIdentity } = await import('./index.mjs');

		expect(await resolveGoogleIdentity('valid-token', '')).toEqual({
			ok: true,
			participantKey: 'google:1234567890',
			name: 'Alex Example'
		});
	});

	it('rejects a token with no name on the payload and no client name given', async () => {
		verifyIdToken.mockResolvedValue({
			getPayload: () => ({ sub: '1234567890', name: '' })
		});
		const { resolveGoogleIdentity } = await import('./index.mjs');

		expect(await resolveGoogleIdentity('valid-token')).toEqual({
			ok: false,
			statusCode: 401,
			error: 'Google profile name is missing'
		});
	});

	it('rejects an invalid or expired token and logs the underlying error', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const underlyingError = new Error('Token used too late');
		verifyIdToken.mockRejectedValue(underlyingError);
		const { resolveGoogleIdentity } = await import('./index.mjs');

		expect(await resolveGoogleIdentity('bad-token')).toEqual({
			ok: false,
			statusCode: 401,
			error: 'Invalid Google token'
		});
		expect(consoleError).toHaveBeenCalledWith(
			'Google ID token verification failed:',
			underlyingError
		);
		consoleError.mockRestore();
	});

	it('returns a 500 when GOOGLE_CLIENT_ID is not configured', async () => {
		delete process.env.GOOGLE_CLIENT_ID;
		const { resolveGoogleIdentity } = await import('./index.mjs');

		expect(await resolveGoogleIdentity('any-token')).toEqual({
			ok: false,
			statusCode: 500,
			error: 'Google auth not configured'
		});
	});
});
