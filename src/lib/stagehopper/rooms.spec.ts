import { describe, expect, it } from 'vitest';
import { generateRoomId, parseRoomIdInput, roomPath } from './rooms.js';
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
