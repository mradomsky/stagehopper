import { describe, expect, it } from 'vitest';
import {
	clearGoogleAuth,
	loadGoogleAuth,
	loadLikedIds,
	loadParticipantFilter,
	loadRoomIdentity,
	saveGoogleAuth,
	saveLikedIds,
	saveParticipantFilter,
	saveRoomIdentity
} from './storage.js';

const identity = { idToken: 'tok', sub: '123', name: 'Alex Example', givenName: 'Alex' };

describe('google auth storage', () => {
	it('round-trips a signed-in identity', () => {
		saveGoogleAuth(identity);
		expect(loadGoogleAuth()).toEqual(identity);
	});

	it('returns null when nothing is stored', () => {
		expect(loadGoogleAuth()).toBeNull();
	});

	it('returns null when a required field is missing', () => {
		saveGoogleAuth(identity);
		localStorage.removeItem('stagehopper:auth:sub');
		expect(loadGoogleAuth()).toBeNull();
	});

	it('defaults a missing given name to empty', () => {
		saveGoogleAuth({ ...identity, givenName: '' });
		expect(loadGoogleAuth()?.givenName).toBe('');
	});

	it('clears every stored field on sign-out', () => {
		saveGoogleAuth(identity);
		clearGoogleAuth();
		expect(loadGoogleAuth()).toBeNull();
	});
});

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

describe('liked ids', () => {
	it('round-trips the liked set', () => {
		saveLikedIds('room', new Set(['a', 'b']));
		expect([...loadLikedIds('room')].sort()).toEqual(['a', 'b']);
	});

	it('returns an empty set when nothing is stored', () => {
		expect(loadLikedIds('room').size).toBe(0);
	});

	it('recovers from corrupted json', () => {
		localStorage.setItem('stagehopper:room:liked', '{not json');
		expect(loadLikedIds('room').size).toBe(0);
	});

	it('ignores non-string entries', () => {
		localStorage.setItem('stagehopper:room:liked', '["a", 3, null]');
		expect([...loadLikedIds('room')]).toEqual(['a']);
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
