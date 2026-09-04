import { describe, expect, it } from 'vitest';
import {
	extractRoomDisplayName,
	generateRoomId,
	parseRoomIdInput,
	roomPath,
	validateRoomDisplayName
} from './rooms.js';
import { getLatestFestival } from './festivals.svelte.js';

describe('generateRoomId', () => {
	it('appends six hex characters to the prefix', () => {
		expect(generateRoomId('tmr26-')).toMatch(/^tmr26-[0-9a-f]{6}$/);
	});
});

describe('roomPath', () => {
	it('namespaces a room id under /room', () => {
		expect(roomPath('tmr26-abc123')).toBe('/room/tmr26-abc123');
	});

	it('namespaces a festival browse id the same way', () => {
		expect(roomPath('tmr26')).toBe('/room/tmr26');
	});

	it('round-trips through parseRoomIdInput, so a shared link can be pasted back', () => {
		expect(parseRoomIdInput(`https://stagehopper.radomskyi.com${roomPath('tmr26-abc123')}`)).toBe(
			'tmr26-abc123'
		);
	});
});

describe('parseRoomIdInput', () => {
	it('passes through a well-formed festival room id', () => {
		expect(parseRoomIdInput('tmr26-abc123')).toBe('tmr26-abc123');
	});

	// The pattern used to enumerate the two festivals that existed when it was written, so a
	// festival added through the admin UI was never recognised as one. It only looked fine
	// because the slug branch returned the same string.
	it('parses a room id for a festival that did not exist at build time', () => {
		expect(parseRoomIdInput('xyz27-1f2c3d')).toBe('xyz27-1f2c3d');
	});

	it('lower-cases a festival room id typed in capitals', () => {
		expect(parseRoomIdInput('XYZ27-1F2C3D')).toBe('xyz27-1f2c3d');
	});

	it('prefixes a bare hex code with the latest festival', () => {
		expect(parseRoomIdInput('abc123')).toBe(`${getLatestFestival().prefix}abc123`);
	});

	it('lowercases a bare hex code', () => {
		expect(parseRoomIdInput('ABC123')).toBe(`${getLatestFestival().prefix}abc123`);
	});

	it('extracts the room id from a full url', () => {
		expect(parseRoomIdInput('https://stagehopper.radomskyi.com/tmr26-abc123')).toBe(
			'tmr26-abc123'
		);
	});

	it('extracts a custom room name from a url with a trailing slash', () => {
		expect(parseRoomIdInput('https://stagehopper.radomskyi.com/birthday-party/')).toBe(
			'birthday-party'
		);
	});

	it('slugifies an arbitrary custom room name', () => {
		expect(parseRoomIdInput('  Max & Friends!! ')).toBe('max-friends');
	});

	it('caps a very long custom name at the slug limit', () => {
		expect(parseRoomIdInput('a'.repeat(80))).toHaveLength(40);
	});

	it('returns null when nothing usable survives slugifying', () => {
		expect(parseRoomIdInput('  !! ')).toBeNull();
	});

	it('returns null for a slug shorter than three characters', () => {
		expect(parseRoomIdInput('ab')).toBeNull();
	});

	it('returns null for empty input', () => {
		expect(parseRoomIdInput('   ')).toBeNull();
	});
});

describe('validateRoomDisplayName', () => {
	it('accepts empty input — naming a room is optional', () => {
		expect(validateRoomDisplayName('')).toBeNull();
		expect(validateRoomDisplayName('   ')).toBeNull();
	});

	it('accepts letters, numbers, spaces, hyphens and underscores', () => {
		expect(validateRoomDisplayName('Squad Goals-2')).toBeNull();
	});

	it('rejects a name over the length limit', () => {
		expect(validateRoomDisplayName('x'.repeat(16))).toMatch(/15 characters/);
	});

	it('rejects a disallowed symbol', () => {
		expect(validateRoomDisplayName('Squad!')).toMatch(/letters, numbers/i);
	});
});

describe('extractRoomDisplayName', () => {
	it('pulls the display-name row out and leaves the rest as participants', () => {
		const items = [
			{ userId: 'clerk:1', selections: {} },
			{ userId: '@room', displayName: 'Squad Goals' },
			{ userId: 'clerk:2', selections: {} }
		];

		expect(extractRoomDisplayName(items)).toEqual({
			participants: [items[0], items[2]],
			displayName: 'Squad Goals'
		});
	});

	it('returns a null name when the room has none', () => {
		const items = [{ userId: 'clerk:1', selections: {} }];

		expect(extractRoomDisplayName(items)).toEqual({ participants: items, displayName: null });
	});

	it('ignores a malformed display-name row rather than throwing', () => {
		const items = [{ userId: '@room', displayName: 42 }];

		expect(extractRoomDisplayName(items)).toEqual({ participants: [], displayName: null });
	});
});
