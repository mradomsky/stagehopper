/**
 * @file StageHopper festivals configuration.
 */

import type { Festival } from './types.js';

export const FESTIVALS: Festival[] = [
	{
		id: 'tmr26',
		prefix: 'tmr26-',
		name: 'Tomorrowland 2026 – Week 1',
		subtitle: 'Boom, Belgium · July 17–20',
		past: false,
		accent: 'linear-gradient(135deg, #ff9a56, #ff6b6b 55%, #c44569)',
		emoji: '🎪'
	},
	{
		id: 'ps26',
		prefix: 'ps26-',
		name: 'Primavera Sound Barcelona 2026',
		subtitle: 'Barcelona · June 4–6',
		past: true,
		accent: 'linear-gradient(135deg, #4facfe, #6c5ce7)',
		emoji: '🌊'
	}
];

/** Find the festival a room id belongs to, by its id prefix. */
export function getFestivalByPrefix(roomId: string): Festival | null {
	return FESTIVALS.find((f) => roomId.startsWith(f.prefix)) ?? null;
}

/** Find festival by exact id — used for guest browse routes, which are bare festival ids. */
export function getFestivalById(id: string): Festival | null {
	return FESTIVALS.find((f) => f.id === id) ?? null;
}

/**
 * True when the given room id is really a festival browse id (`/tmr26`) rather than
 * a joinable room (`/tmr26-abc123`). Browsing is read-only and needs no sign-in.
 */
export function isFestivalBrowseId(roomId: string): boolean {
	return FESTIVALS.some((f) => f.id === roomId);
}

/** The festival new rooms/timetables default to when nothing else specifies one. */
export function getLatestFestival(): Festival {
	const upcoming = FESTIVALS.find((f) => !f.past);
	const fallback = FESTIVALS[0];
	if (!upcoming && !fallback) {
		throw new Error('FESTIVALS must not be empty');
	}
	return upcoming ?? (fallback as Festival);
}
