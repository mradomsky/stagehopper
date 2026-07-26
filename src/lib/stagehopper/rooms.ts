/**
 * @file Room id generation and parsing.
 */

import { getLatestFestival } from './festivals.js';

/** A room id owned by a known festival, e.g. `tmr26-1f4c9a`. */
const FESTIVAL_ROOM_ID_PATTERN = /^(ps26|tmr26)-[0-9a-f]{6}$/;
/** The random suffix on its own, as typed by someone reading it off a screen. */
const BARE_HEX_PATTERN = /^[0-9a-f]{6}$/i;
/** Custom room names are slugs; the backend enforces the same shape. */
const MAX_SLUG_LENGTH = 40;
const MIN_SLUG_LENGTH = 3;

/** Generate a random room id for the given festival prefix. */
export function generateRoomId(prefix: string): string {
	const randomHex = Math.floor(Math.random() * 16777216)
		.toString(16)
		.padStart(6, '0');
	return `${prefix}${randomHex}`;
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, MAX_SLUG_LENGTH);
}

/**
 * Parse a user-entered room reference — a bare hex code, a full `ps26-`/`tmr26-` id, a
 * custom vanity name, or a full room URL — into a concrete room id. Returns null if
 * nothing usable could be extracted.
 */
export function parseRoomIdInput(rawInput: string): string | null {
	const trimmed = rawInput.trim();
	if (!trimmed) return null;

	let candidate = trimmed;
	if (/^https?:\/\//i.test(trimmed) || trimmed.includes('/')) {
		try {
			const url = /^https?:\/\//i.test(trimmed)
				? new URL(trimmed)
				: new URL(trimmed, 'https://placeholder.invalid');
			const segments = url.pathname.split('/').filter(Boolean);
			candidate = segments[segments.length - 1] ?? trimmed;
		} catch {
			candidate = trimmed;
		}
	}

	if (FESTIVAL_ROOM_ID_PATTERN.test(candidate)) {
		return candidate;
	}
	if (BARE_HEX_PATTERN.test(candidate)) {
		return `${getLatestFestival().prefix}${candidate.toLowerCase()}`;
	}

	const slug = slugify(candidate);
	return slug.length >= MIN_SLUG_LENGTH ? slug : null;
}
