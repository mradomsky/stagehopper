import { describe, expect, it } from 'vitest';

import {
	isAnonymousParticipantKey,
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

	it('rejects google keys', () => {
		expect(isSupportedParticipantKey('google:12345678901234567890')).toBe(false);
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
