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

import type { GoogleIdentity, RoomSelection, SelectionMap } from './types.js';

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

// ---- Room state snapshots (for offline resilience) ----

export interface MySnapshot {
	selections: SelectionMap;
	pendingWrite: boolean;
}

/**
 * Save a snapshot of the current user's picks in this room.
 * Used to survive a reload or connection loss without losing unsynced edits.
 */
export function saveMySnapshot(roomId: string, selections: Record<string, number>, pendingWrite: boolean): void {
	const key = `${ROOM_PREFIX}:${roomId}:mySnapshot`;
	writeItem(key, JSON.stringify({ selections, pendingWrite }));
}

/**
 * Load the current user's previously saved picks for this room, if any.
 * Returns null if nothing is stored or the stored data is malformed.
 */
export function loadMySnapshot(roomId: string): MySnapshot | null {
	const raw = readItem(`${ROOM_PREFIX}:${roomId}:mySnapshot`);
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			parsed &&
			typeof parsed === 'object' &&
			'selections' in parsed &&
			'pendingWrite' in parsed &&
			typeof (parsed as Record<string, unknown>).selections === 'object' &&
			typeof (parsed as Record<string, unknown>).pendingWrite === 'boolean'
		) {
			return parsed as MySnapshot;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Save a snapshot of all room participants' picks.
 * Used to hydrate the room when the network fails on reload.
 */
export function saveAllSnapshot(roomId: string, all: RoomSelection[]): void {
	const key = `${ROOM_PREFIX}:${roomId}:allSnapshot`;
	writeItem(key, JSON.stringify(all));
}

/**
 * Load all participants' previously saved picks for this room, if any.
 * Returns null if nothing is stored, the stored data is malformed, or not an array of RoomSelection objects.
 */
export function loadAllSnapshot(roomId: string): RoomSelection[] | null {
	const raw = readItem(`${ROOM_PREFIX}:${roomId}:allSnapshot`);
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			Array.isArray(parsed) &&
			parsed.every(
				(item) =>
					item &&
					typeof item === 'object' &&
					typeof (item as Record<string, unknown>).userId === 'string' &&
					typeof (item as Record<string, unknown>).name === 'string' &&
					typeof (item as Record<string, unknown>).color === 'string' &&
					typeof (item as Record<string, unknown>).selections === 'object'
			)
		) {
			return parsed as RoomSelection[];
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Clear both snapshot keys for a single room.
 */
export function clearRoomSnapshots(roomId: string): void {
	removeItem(`${ROOM_PREFIX}:${roomId}:mySnapshot`);
	removeItem(`${ROOM_PREFIX}:${roomId}:allSnapshot`);
}

/**
 * Clear all snapshot keys across all rooms.
 * Sweeps localStorage for any key matching the snapshot pattern.
 */
export function clearAllRoomSnapshots(): void {
	try {
		if (typeof localStorage === 'undefined') return;
		const snapshotPattern = /^stagehopper:.*:(mySnapshot|allSnapshot)$/;
		const keysToDelete = [];
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (key && snapshotPattern.test(key)) {
				keysToDelete.push(key);
			}
		}
		keysToDelete.forEach((key) => removeItem(key));
	} catch {
		// Storage unavailable — nothing to do.
	}
}
