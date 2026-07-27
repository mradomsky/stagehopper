import { describe, expect, it } from 'vitest';
import {
	FESTIVALS,
	getFestivalById,
	getFestivalByPrefix,
	getLatestFestival,
	isFestivalBrowseId
} from './festivals.js';

describe('festival configuration', () => {
	it('gives every festival a unique id and a matching prefix', () => {
		const ids = FESTIVALS.map((festival) => festival.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const festival of FESTIVALS) {
			expect(festival.prefix).toBe(`${festival.id}-`);
		}
	});
});

describe('getFestivalByPrefix', () => {
	it('resolves a room id to its festival', () => {
		expect(getFestivalByPrefix('tmr26-abc123')?.id).toBe('tmr26');
	});

	it('returns null for a custom room name', () => {
		expect(getFestivalByPrefix('birthday-party')).toBeNull();
	});
});

describe('getFestivalById', () => {
	it('resolves a bare festival id', () => {
		expect(getFestivalById('ps26')?.id).toBe('ps26');
	});

	it('does not resolve a room id', () => {
		expect(getFestivalById('ps26-abc123')).toBeNull();
	});
});

describe('isFestivalBrowseId', () => {
	it('recognises a bare festival id as a browse route', () => {
		expect(isFestivalBrowseId('tmr26')).toBe(true);
	});

	it('does not treat a joinable room as a browse route', () => {
		expect(isFestivalBrowseId('tmr26-abc123')).toBe(false);
	});
});

describe('getLatestFestival', () => {
	it('returns the festival that has not happened yet', () => {
		expect(getLatestFestival().past).toBe(false);
	});
});
