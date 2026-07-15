import { describe, expect, it } from 'vitest';

import {
	isAnonymousParticipantKey,
	isGoogleParticipantKey,
	isLegacyAnonymousParticipantKey,
	isSupportedParticipantKey,
	resolveWriteIdentity
} from './participant-keys.mjs';

describe('participant key helpers', () => {
	it('accepts legacy anonymous uuid keys', () => {
		expect(isLegacyAnonymousParticipantKey('3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe(true);
		expect(isSupportedParticipantKey('3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe(true);
	});

	it('accepts explicit anonymous keys', () => {
		expect(isAnonymousParticipantKey('anon:3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe(true);
		expect(isSupportedParticipantKey('anon:3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe(true);
	});

	it('accepts google keys', () => {
		expect(isGoogleParticipantKey('google:12345678901234567890')).toBe(true);
		expect(isSupportedParticipantKey('google:12345678901234567890')).toBe(true);
	});

	it('rejects malformed google keys', () => {
		expect(isGoogleParticipantKey('google:')).toBe(false);
		expect(isGoogleParticipantKey('google:not-numeric')).toBe(false);
		expect(isSupportedParticipantKey('google:not-numeric')).toBe(false);
	});
});

describe('resolveWriteIdentity', () => {
	it('allows anonymous writes with explicit participant keys', () => {
		expect(
			resolveWriteIdentity({
				participantKey: 'anon:3fa85f64-5717-4562-b3fc-2c963f66afa6',
				name: 'Alex'
			})
		).toEqual({
			ok: true,
			participantKey: 'anon:3fa85f64-5717-4562-b3fc-2c963f66afa6',
			name: 'Alex'
		});
	});

	it('rejects missing name', () => {
		expect(
			resolveWriteIdentity({
				participantKey: 'anon:3fa85f64-5717-4562-b3fc-2c963f66afa6',
				name: ''
			})
		).toEqual({
			ok: false,
			statusCode: 400,
			error: 'name is required'
		});
	});

	it('rejects invalid participantKey', () => {
		expect(
			resolveWriteIdentity({
				participantKey: 'not-a-real-key',
				name: 'Alex'
			})
		).toEqual({
			ok: false,
			statusCode: 400,
			error: 'Invalid participantKey'
		});
	});

	it('rejects a client-claimed google key even though the shape is recognized elsewhere', () => {
		// google:<sub> is only ever assigned by resolveGoogleIdentity after verifying an ID
		// token — the unverified write path must not let a caller claim one just by naming it,
		// even though isSupportedParticipantKey recognizes the shape as valid overall.
		expect(isSupportedParticipantKey('google:12345678901234567890')).toBe(true);
		expect(
			resolveWriteIdentity({
				participantKey: 'google:12345678901234567890',
				name: 'Alex'
			})
		).toEqual({
			ok: false,
			statusCode: 400,
			error: 'Invalid participantKey'
		});
	});
});
