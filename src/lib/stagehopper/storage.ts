/**
 * @file Everything StageHopper keeps in localStorage.
 *
 * Per-room hints only: display name/colour, favourite stages, participant filter. They
 * are a fast local cache — the backend's participant list stays the source of truth.
 *
 * The signed-in identity is *not* here. Clerk owns the session and stores it itself, so
 * there is no token to cache and nothing to expire.
 *
 * Every access is guarded: storage is unavailable during prerendering and throws
 * outright in Safari private mode, and losing a cached hint is never fatal.
 */

import type { RoomSelection, SelectionMap } from './types.js';

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

// ---- Push subscription endpoint ----
//
// The endpoint this device last registered with the server. Push services (Safari/iOS
// especially) can rotate a subscription's endpoint out from under us; remembering the last
// one lets the notifications popup delete the superseded server row instead of leaving it
// orphaned, so a device never piles up duplicate subscriptions across rotations.

// Keeps its historical `stagehopper:auth:` prefix: the key is what a device already has
// written, and renaming it would orphan every live subscription row.
const PUSH_ENDPOINT_KEY = 'stagehopper:auth:pushEndpoint';

export function loadPushEndpoint(): string | null {
	return readItem(PUSH_ENDPOINT_KEY);
}

export function savePushEndpoint(endpoint: string): void {
	writeItem(PUSH_ENDPOINT_KEY, endpoint);
}

export function clearPushEndpoint(): void {
	removeItem(PUSH_ENDPOINT_KEY);
}

// ---- Per-room hints ----

export interface RoomIdentityCache {
	name: string;
	color: string;
}

/** The display name/colour this user already picked in this room. */
export function loadRoomIdentity(roomId: string): RoomIdentityCache | null {
	const name = readItem(`${ROOM_PREFIX}:${roomId}:name`);
	const color = readItem(`${ROOM_PREFIX}:${roomId}:color`);
	return name && color ? { name, color } : null;
}

export function saveRoomIdentity(roomId: string, name: string, color: string): void {
	writeItem(`${ROOM_PREFIX}:${roomId}:name`, name);
	writeItem(`${ROOM_PREFIX}:${roomId}:color`, color);
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
