import { describe, expect, it } from 'vitest';
import {
	clearAllRoomSnapshots,
	clearRoomSnapshots,
	loadAllSnapshot,
	loadFavouriteStages,
	loadMySnapshot,
	loadParticipantFilter,
	loadRoomIdentity,
	saveFavouriteStages,
	saveAllSnapshot,
	saveMySnapshot,
	saveParticipantFilter,
	saveRoomIdentity
} from './storage.js';
import type { RoomSelection } from './types.js';

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

describe('participant filter', () => {
	it('round-trips an explicit selection', () => {
		saveParticipantFilter('room', ['google:1']);
		expect(loadParticipantFilter('room')).toEqual(['google:1']);
	});

	it('stores an empty selection as only-me rather than dropping it', () => {
		saveParticipantFilter('room', []);
		expect(loadParticipantFilter('room')).toEqual([]);
	});

	it('removes the entry for the show-everyone state', () => {
		saveParticipantFilter('room', ['google:1']);
		saveParticipantFilter('room', null);
		expect(loadParticipantFilter('room')).toBeNull();
	});

	it('recovers from corrupted json', () => {
		localStorage.setItem('stagehopper:room:selectedOtherUserIds', '{not json');
		expect(loadParticipantFilter('room')).toBeNull();
	});
});

describe('my snapshot', () => {
	it('round-trips selections and pending flag', () => {
		const snap = { selections: { p1: 1, p2: 2 }, pendingWrite: true };
		saveMySnapshot('room', snap.selections, snap.pendingWrite);
		expect(loadMySnapshot('room')).toEqual(snap);
	});

	it('returns null when nothing is stored', () => {
		expect(loadMySnapshot('room')).toBeNull();
	});

	it('returns null for malformed json', () => {
		localStorage.setItem('stagehopper:room:mySnapshot', '{not json');
		expect(loadMySnapshot('room')).toBeNull();
	});

	it('returns null when required fields are missing', () => {
		localStorage.setItem('stagehopper:room:mySnapshot', '{"selections": {}}');
		expect(loadMySnapshot('room')).toBeNull();
	});

	it('keeps rooms independent', () => {
		saveMySnapshot('room1', { p1: 1 }, false);
		expect(loadMySnapshot('room2')).toBeNull();
	});
});

describe('all snapshot', () => {
	it('round-trips an array of room selections', () => {
		const snap: RoomSelection[] = [
			{ userId: 'google:1', name: 'Alice', color: '#e74c3c', selections: { p1: 1 } },
			{ userId: 'google:2', name: 'Bob', color: '#3498db', selections: { p1: 2 } }
		];
		saveAllSnapshot('room', snap);
		expect(loadAllSnapshot('room')).toEqual(snap);
	});

	it('returns null when nothing is stored', () => {
		expect(loadAllSnapshot('room')).toBeNull();
	});

	it('returns null for malformed json', () => {
		localStorage.setItem('stagehopper:room:allSnapshot', '{not json');
		expect(loadAllSnapshot('room')).toBeNull();
	});

	it('returns null when items lack userId', () => {
		localStorage.setItem('stagehopper:room:allSnapshot', '[{"name": "Alice"}]');
		expect(loadAllSnapshot('room')).toBeNull();
	});

	it('returns null when not an array', () => {
		localStorage.setItem('stagehopper:room:allSnapshot', '{"userId": "google:1"}');
		expect(loadAllSnapshot('room')).toBeNull();
	});

	it('keeps rooms independent', () => {
		saveAllSnapshot('room1', [{ userId: 'google:1', name: 'Alice', color: '#e74c3c', selections: {} }]);
		expect(loadAllSnapshot('room2')).toBeNull();
	});
});

describe('room snapshot cleanup', () => {
	it('clears both snapshot keys for a room', () => {
		saveMySnapshot('room', { p1: 1 }, false);
		saveAllSnapshot('room', [{ userId: 'google:1', name: 'Alice', color: '#e74c3c', selections: {} }]);
		clearRoomSnapshots('room');
		expect(loadMySnapshot('room')).toBeNull();
		expect(loadAllSnapshot('room')).toBeNull();
	});

	it('does not affect other rooms', () => {
		saveMySnapshot('room1', { p1: 1 }, false);
		saveMySnapshot('room2', { p1: 2 }, true);
		clearRoomSnapshots('room1');
		expect(loadMySnapshot('room1')).toBeNull();
		expect(loadMySnapshot('room2')).not.toBeNull();
	});

	it('sweeps all snapshot keys on global clear', () => {
		saveMySnapshot('room1', { p1: 1 }, false);
		saveAllSnapshot('room1', [{ userId: 'google:1', name: 'Alice', color: '#e74c3c', selections: {} }]);
		saveMySnapshot('room2', { p1: 2 }, true);
		saveAllSnapshot('room2', [{ userId: 'google:2', name: 'Bob', color: '#3498db', selections: {} }]);
		clearAllRoomSnapshots();
		expect(loadMySnapshot('room1')).toBeNull();
		expect(loadAllSnapshot('room1')).toBeNull();
		expect(loadMySnapshot('room2')).toBeNull();
		expect(loadAllSnapshot('room2')).toBeNull();
	});

	it('does not affect other storage keys on global clear', () => {
		saveRoomIdentity('room', 'Alice', '#e74c3c');
		saveMySnapshot('room', { p1: 1 }, false);
		clearAllRoomSnapshots();
		expect(loadRoomIdentity('room')).not.toBeNull();
	});
});
