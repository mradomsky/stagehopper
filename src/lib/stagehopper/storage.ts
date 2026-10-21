/**
 * @file Everything StageHopper keeps in localStorage.
 *
 * Mostly per-Festival hints such as favourite stages. They are a fast local cache — the
 * backend stays the source of truth. A couple of entries are viewer-wide instead (push endpoint, timetable layout).
 *
 * The signed-in identity is *not* here. Clerk owns the session and stores it itself, so
 * there is no token to cache and nothing to expire.
 *
 * Every access is guarded: storage is unavailable during prerendering and throws
 * outright in Safari private mode, and losing a cached hint is never fatal.
 */

import { STORAGE_PREFIX } from './config.js';
import type { TimetableLayout } from './types.js';

export function readItem(key: string): string | null {
	try {
		if (typeof localStorage === 'undefined') return null;
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function writeItem(key: string, value: string): void {
	try {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem(key, value);
	} catch {
		// Storage full or blocked — the app works without the cache.
	}
}

export function removeItem(key: string): void {
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

// ---- Timetable layout ----
//
// Grid or list is a preference about the viewer, not about one Festival: someone who reads
// the schedule as a list reads every festival that way. Hence a single global key rather
// than the per-Festival hints below.

const TIMETABLE_LAYOUT_KEY = `${STORAGE_PREFIX}:view:timetableLayout`;

export function loadTimetableLayout(): TimetableLayout {
	return readItem(TIMETABLE_LAYOUT_KEY) === 'list' ? 'list' : 'grid';
}

export function saveTimetableLayout(layout: TimetableLayout): void {
	writeItem(TIMETABLE_LAYOUT_KEY, layout);
}

// ---- Per-Festival hints ----

export function loadFavouriteStages(festivalId: string): Set<string> {
	const raw = readItem(`${STORAGE_PREFIX}:${festivalId}:favStages`);
	if (!raw) return new Set();
	try {
		const parsed: unknown = JSON.parse(raw);
		return new Set(Array.isArray(parsed) ? parsed.filter((name) => typeof name === 'string') : []);
	} catch {
		return new Set();
	}
}

export function saveFavouriteStages(festivalId: string, stageNames: ReadonlySet<string>): void {
	writeItem(`${STORAGE_PREFIX}:${festivalId}:favStages`, JSON.stringify([...stageNames]));
}

