import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoogleIdentity } from './types.js';

vi.mock('./storage.js', () => ({
	loadGoogleAuth: vi.fn(),
	saveGoogleAuth: vi.fn(),
	clearGoogleAuth: vi.fn()
}));

vi.mock('./google-identity.js', () => ({
	getGoogleClientId: vi.fn(() => 'client-1'),
	isGoogleIdTokenExpired: vi.fn(),
	parseGoogleIdTokenClaims: vi.fn(),
	refreshGoogleIdToken: vi.fn()
}));

import { ensureFreshGoogleAuth } from './auth.js';
import { clearGoogleAuth, loadGoogleAuth, saveGoogleAuth } from './storage.js';
import {
	isGoogleIdTokenExpired,
	parseGoogleIdTokenClaims,
	refreshGoogleIdToken
} from './google-identity.js';

const load = vi.mocked(loadGoogleAuth);
const save = vi.mocked(saveGoogleAuth);
const clear = vi.mocked(clearGoogleAuth);
const expired = vi.mocked(isGoogleIdTokenExpired);
const parse = vi.mocked(parseGoogleIdTokenClaims);
const refresh = vi.mocked(refreshGoogleIdToken);

const CURRENT: GoogleIdentity = { idToken: 'old', sub: 'u1', name: 'Alex', givenName: 'Alex' };

describe('ensureFreshGoogleAuth', () => {
	beforeEach(() => {
		load.mockReset();
		save.mockReset();
		clear.mockReset();
		expired.mockReset();
		parse.mockReset();
		refresh.mockReset();
	});

	it('returns the cached identity untouched while its token is still valid', async () => {
		load.mockReturnValue(CURRENT);
		expired.mockReturnValue(false);

		await expect(ensureFreshGoogleAuth()).resolves.toEqual(CURRENT);
		expect(refresh).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
	});

	it('silently refreshes and persists a new identity when the token has expired', async () => {
		load.mockReturnValue(CURRENT);
		expired.mockReturnValue(true);
		refresh.mockResolvedValue('new-token');
		parse.mockReturnValue({ sub: 'u1', name: 'Alex', givenName: 'Alex' });

		const result = await ensureFreshGoogleAuth();

		expect(result).toEqual({ idToken: 'new-token', sub: 'u1', name: 'Alex', givenName: 'Alex' });
		expect(save).toHaveBeenCalledWith(result);
		expect(clear).not.toHaveBeenCalled();
	});

	it('clears the stale token and returns null when refresh fails', async () => {
		load.mockReturnValue(CURRENT);
		expired.mockReturnValue(true);
		refresh.mockResolvedValue(null);

		await expect(ensureFreshGoogleAuth()).resolves.toBeNull();
		expect(clear).toHaveBeenCalledOnce();
		expect(save).not.toHaveBeenCalled();
	});

	it('signs in silently when nothing is cached but a Google session exists', async () => {
		load.mockReturnValue(null);
		refresh.mockResolvedValue('new-token');
		parse.mockReturnValue({ sub: 'u2', name: 'Sam', givenName: 'Sam' });

		const result = await ensureFreshGoogleAuth();

		expect(result).toEqual({ idToken: 'new-token', sub: 'u2', name: 'Sam', givenName: 'Sam' });
		expect(save).toHaveBeenCalledWith(result);
	});

	it('dedupes concurrent refreshes into a single One Tap', async () => {
		load.mockReturnValue(CURRENT);
		expired.mockReturnValue(true);
		let resolveRefresh!: (token: string) => void;
		refresh.mockReturnValue(new Promise<string>((r) => (resolveRefresh = r)));
		parse.mockReturnValue({ sub: 'u1', name: 'Alex', givenName: 'Alex' });

		const a = ensureFreshGoogleAuth();
		const b = ensureFreshGoogleAuth();
		resolveRefresh('new-token');
		const [ra, rb] = await Promise.all([a, b]);

		expect(refresh).toHaveBeenCalledOnce();
		expect(ra).toEqual(rb);
	});
});
