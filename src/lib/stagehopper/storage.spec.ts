import { describe, expect, it } from 'vitest';
import {
	loadFavouriteStages,
	saveFavouriteStages,
	loadTimetableLayout,
	saveTimetableLayout
} from './storage.js';

describe('stored key names', () => {
	// Renaming a key silently drops every returning visitor's saved choice.
	it('keeps the favourite stages and layout keys unchanged', () => {
		saveFavouriteStages('tmr26', new Set(['MAIN']));
		saveTimetableLayout('list');

		expect(localStorage.getItem('stagehopper:tmr26:favStages')).toBe('["MAIN"]');
		expect(localStorage.getItem('stagehopper:view:timetableLayout')).toBe('list');
		expect(loadTimetableLayout()).toBe('list');
	});
});

describe('favourite stages', () => {
	it('round-trips the favourite set', () => {
		saveFavouriteStages('tmr26', new Set(['MAIN', 'TENT']));
		expect([...loadFavouriteStages('tmr26')].sort()).toEqual(['MAIN', 'TENT']);
	});

	it('returns an empty set when nothing is stored', () => {
		expect(loadFavouriteStages('tmr26').size).toBe(0);
	});

	it('keeps Festivals independent', () => {
		saveFavouriteStages('tmr26', new Set(['MAIN']));
		expect(loadFavouriteStages('other').size).toBe(0);
	});

	it('recovers from corrupted json', () => {
		localStorage.setItem('stagehopper:tmr26:favStages', '{not json');
		expect(loadFavouriteStages('tmr26').size).toBe(0);
	});

	it('ignores non-string entries', () => {
		localStorage.setItem('stagehopper:tmr26:favStages', '["MAIN", 3, null]');
		expect([...loadFavouriteStages('tmr26')]).toEqual(['MAIN']);
	});
});

