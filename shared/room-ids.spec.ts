import { describe, expect, it } from 'vitest';
import {
	FESTIVAL_ROOM_ID_REGEX,
	MAX_ROOM_DISPLAY_NAME_LENGTH,
	ROOM_DISPLAY_NAME_REGEX,
	ROOM_NAME_USER_ID,
	VALID_ROOM_ID_REGEX,
	extractRoomDisplayName,
	festivalIdFromRoomId
} from './room-ids.js';

describe('festivalIdFromRoomId', () => {
	it('reads the festival off a prefixed id', () => {
		expect(festivalIdFromRoomId('tmr26-1f4c9a')).toBe('tmr26');
	});

	it.each([
		['a custom slug', 'my-cool-room'],
		['an uppercase id', 'TMR26-1F4C9A'],
		['a non-hex suffix', 'tmr26-zzzzzz'],
		['a short suffix', 'tmr26-1f4c9'],
		['an over-long prefix', 'waytoolongfest-1f4c9a']
	])('returns null for %s', (_label, roomId) => {
		expect(festivalIdFromRoomId(roomId)).toBeNull();
	});
});

describe('VALID_ROOM_ID_REGEX', () => {
	it.each([['tmr26-1f4c9a'], ['my-cool-room'], ['abc'], ['a'.repeat(40)]])('accepts %s', (id) => {
		expect(VALID_ROOM_ID_REGEX.test(id)).toBe(true);
	});

	it.each([
		['empty', ''],
		['too short a slug', 'ab'],
		['too long a slug', 'a'.repeat(41)],
		['a leading hyphen', '-room'],
		['a trailing hyphen', 'room-'],
		['uppercase', 'MyRoom'],
		['a space', 'my room']
	])('rejects %s', (_label, id) => {
		expect(VALID_ROOM_ID_REGEX.test(id)).toBe(false);
	});

	it('accepts every id the prefixed form accepts', () => {
		const prefixed = 'tmr26-1f4c9a';
		expect(FESTIVAL_ROOM_ID_REGEX.test(prefixed)).toBe(true);
		expect(VALID_ROOM_ID_REGEX.test(prefixed)).toBe(true);
	});
});

describe('room display names', () => {
	it('caps at the shared length', () => {
		expect(MAX_ROOM_DISPLAY_NAME_LENGTH).toBe(15);
		expect(ROOM_DISPLAY_NAME_REGEX.test('a'.repeat(15))).toBe(true);
	});

	it.each([['Camp Alpha'], ['squad_9'], ['a-b']])('accepts %s', (name) => {
		expect(ROOM_DISPLAY_NAME_REGEX.test(name)).toBe(true);
	});

	it.each([['emoji 🎪'], ['comma,'], ['']])('rejects %s', (name) => {
		expect(ROOM_DISPLAY_NAME_REGEX.test(name)).toBe(false);
	});
});

describe('extractRoomDisplayName', () => {
	it('pulls the reserved row out of the participant list', () => {
		const rows = [
			{ userId: 'clerk:u1', displayName: undefined },
			{ userId: ROOM_NAME_USER_ID, displayName: 'Camp Alpha' },
			{ userId: 'clerk:u2', displayName: undefined }
		];

		const { participants, displayName } = extractRoomDisplayName(rows);

		expect(displayName).toBe('Camp Alpha');
		expect(participants.map((p) => p.userId)).toEqual(['clerk:u1', 'clerk:u2']);
	});

	it('reports no name when the reserved row is absent', () => {
		const { participants, displayName } = extractRoomDisplayName([{ userId: 'clerk:u1' }]);
		expect(displayName).toBeNull();
		expect(participants).toHaveLength(1);
	});

	it('ignores a reserved row carrying a non-string name, and still drops it', () => {
		const { participants, displayName } = extractRoomDisplayName([
			{ userId: ROOM_NAME_USER_ID, displayName: 42 }
		]);
		expect(displayName).toBeNull();
		expect(participants).toEqual([]);
	});
});
