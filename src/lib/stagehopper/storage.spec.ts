import { describe, expect, it } from 'vitest';
import {
	loadFavouriteStages,
	loadRoomIdentity,
	saveFavouriteStages,
	saveRoomIdentity
} from './storage.js';

describe('room identity cache', () => {
	it('round-trips a name and colour per room', () => {
		saveRoomIdentity('tmr26-abc123', 'Alex', '#e74c3c');
		expect(loadRoomIdentity('tmr26-abc123')).toEqual({ name: 'Alex', color: '#e74c3c' });
	});

	it('keeps rooms independent', () => {
		saveRoomIdentity('tmr26-abc123', 'Alex', '#e74c3c');
		expect(loadRoomIdentity('tmr26-other1')).toBeNull();
	});
});

describe('favourite stages', () => {
	it('round-trips the favourite set', () => {
		saveFavouriteStages('room', new Set(['MAIN', 'TENT']));
		expect([...loadFavouriteStages('room')].sort()).toEqual(['MAIN', 'TENT']);
	});

	it('returns an empty set when nothing is stored', () => {
		expect(loadFavouriteStages('room').size).toBe(0);
	});

	it('keeps rooms independent', () => {
		saveFavouriteStages('room', new Set(['MAIN']));
		expect(loadFavouriteStages('other').size).toBe(0);
	});

	it('recovers from corrupted json', () => {
		localStorage.setItem('stagehopper:room:favStages', '{not json');
		expect(loadFavouriteStages('room').size).toBe(0);
	});

	it('ignores non-string entries', () => {
		localStorage.setItem('stagehopper:room:favStages', '["MAIN", 3, null]');
		expect([...loadFavouriteStages('room')]).toEqual(['MAIN']);
	});
});

