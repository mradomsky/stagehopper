/**
 * @file Everything StageHopper keeps in localStorage.
 *
 * Two scopes live here: the site-wide signed-in Google identity, and per-room hints
 * (display name/colour, liked performances, participant filter). Room hints are only
 * a fast local cache — the backend's participant list stays the source of truth.
 *
 * Every access is guarded: storage is unavailable during prerendering and throws
 * outright in Safari private mode, and losing a cached hint is never fatal.
 */

import type { GoogleIdentity } from './types.js';

const AUTH_PREFIX = 'stagehopper:auth';
const ROOM_PREFIX = 'stagehopper';

function readItem(key: string): string | null {
	try {
		if (typeof localStorage === 'undefined') return null;
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeItem(key: string, value: string): void {
	try {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem(key, value);
	} catch {
		// Storage full or blocked — the app works without the cache.
	}
}

function removeItem(key: string): void {
	try {
		if (typeof localStorage === 'undefined') return;
		localStorage.removeItem(key);
	} catch {
		// Nothing to do if storage is unavailable.
	}
}

// ---- Site-wide Google identity ----

export function saveGoogleAuth(identity: GoogleIdentity): void {
	writeItem(`${AUTH_PREFIX}:idToken`, identity.idToken);
	writeItem(`${AUTH_PREFIX}:sub`, identity.sub);
	writeItem(`${AUTH_PREFIX}:name`, identity.name);
	writeItem(`${AUTH_PREFIX}:givenName`, identity.givenName);
}

export function loadGoogleAuth(): GoogleIdentity | null {
	const idToken = readItem(`${AUTH_PREFIX}:idToken`);
	const sub = readItem(`${AUTH_PREFIX}:sub`);
	const name = readItem(`${AUTH_PREFIX}:name`);
	if (!idToken || !sub || !name) return null;
	return { idToken, sub, name, givenName: readItem(`${AUTH_PREFIX}:givenName`) ?? '' };
}

export function clearGoogleAuth(): void {
	removeItem(`${AUTH_PREFIX}:idToken`);
	removeItem(`${AUTH_PREFIX}:sub`);
	removeItem(`${AUTH_PREFIX}:name`);
	removeItem(`${AUTH_PREFIX}:givenName`);
}

// ---- Per-room hints ----

export interface RoomIdentityCache {
	name: string;
	color: string;
}

/** The display name/colour this Google identity already picked in this room. */
export function loadRoomIdentity(roomId: string): RoomIdentityCache | null {
	const name = readItem(`${ROOM_PREFIX}:${roomId}:name`);
	const color = readItem(`${ROOM_PREFIX}:${roomId}:color`);
	return name && color ? { name, color } : null;
}

export function saveRoomIdentity(roomId: string, name: string, color: string): void {
	writeItem(`${ROOM_PREFIX}:${roomId}:name`, name);
	writeItem(`${ROOM_PREFIX}:${roomId}:color`, color);
}

export function loadLikedIds(roomId: string): Set<string> {
	const raw = readItem(`${ROOM_PREFIX}:${roomId}:liked`);
	if (!raw) return new Set();
	try {
		const parsed: unknown = JSON.parse(raw);
		return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
	} catch {
		return new Set();
	}
}

export function saveLikedIds(roomId: string, likedIds: ReadonlySet<string>): void {
	writeItem(`${ROOM_PREFIX}:${roomId}:liked`, JSON.stringify([...likedIds]));
}

export function loadFavouriteStages(roomId: string): Set<string> {
	const raw = readItem(`${ROOM_PREFIX}:${roomId}:favStages`);
	if (!raw) return new Set();
	try {
		const parsed: unknown = JSON.parse(raw);
		return new Set(Array.isArray(parsed) ? parsed.filter((name) => typeof name === 'string') : []);
	} catch {
		return new Set();
	}
}

export function saveFavouriteStages(roomId: string, stageNames: ReadonlySet<string>): void {
	writeItem(`${ROOM_PREFIX}:${roomId}:favStages`, JSON.stringify([...stageNames]));
}

/** Null means "show every participant"; an empty array means "only me". */
export function loadParticipantFilter(roomId: string): string[] | null {
	const raw = readItem(`${ROOM_PREFIX}:${roomId}:selectedOtherUserIds`);
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : null;
	} catch {
		return null;
	}
}

export function saveParticipantFilter(roomId: string, selectedOtherUserIds: string[] | null): void {
	const key = `${ROOM_PREFIX}:${roomId}:selectedOtherUserIds`;
	if (!selectedOtherUserIds) {
		removeItem(key);
		return;
	}
	writeItem(key, JSON.stringify(selectedOtherUserIds));
}
