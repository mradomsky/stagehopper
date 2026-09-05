/**
 * @file Room id generation and parsing.
 */

import { getLatestFestival } from './festivals.svelte.js';
import {
	BARE_ROOM_SUFFIX_REGEX,
	FESTIVAL_ROOM_ID_REGEX,
	MAX_ROOM_DISPLAY_NAME_LENGTH,
	MAX_ROOM_SLUG_LENGTH,
	MIN_ROOM_SLUG_LENGTH,
	ROOM_DISPLAY_NAME_REGEX
} from '$shared/room-ids.js';

/**
 * The room-id and room-naming rules live in `shared/room-ids.ts`, imported by this module
 * and by both Lambdas. They used to be declared here *and* there, with a comment naming the
 * Lambda copy "the real authority" — an accurate description of a mirror nothing enforced.
 *
 * They are shapes, not lists of festivals. The enumerated `(ps26|tmr26)` this replaced
 * predated the admin UI, so no festival added since was recognised — it fell through to the
 * slug branch below, which happened to return a well-formed room id unchanged and so hid the
 * bug entirely. That only holds while slugifying and the room-id shape agree, which is now
 * one fact rather than two.
 */
export { MAX_ROOM_DISPLAY_NAME_LENGTH, extractRoomDisplayName } from '$shared/room-ids.js';

/**
 * Rooms live under their own path segment so that top-level routes (`/admin`, and any
 * future page) can never be shadowed by a room whose custom slug happens to match.
 */
export const ROOM_PATH_PREFIX = '/room';

/** The in-app path for a room id, for both links and navigation. */
export function roomPath(roomId: string): string {
	return `${ROOM_PATH_PREFIX}/${roomId}`;
}

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
		.slice(0, MAX_ROOM_SLUG_LENGTH);
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

	// Lower-cased before matching, not after: the backend's ids are lowercase, so that is the
	// only shape the shared rules describe. Someone typing one off a screen in caps used to be
	// rescued by slugify() on the branch below.
	const lowered = candidate.toLowerCase();
	if (FESTIVAL_ROOM_ID_REGEX.test(lowered)) {
		return lowered;
	}
	if (BARE_ROOM_SUFFIX_REGEX.test(lowered)) {
		return `${getLatestFestival().prefix}${lowered}`;
	}

	const slug = slugify(candidate);
	return slug.length >= MIN_ROOM_SLUG_LENGTH ? slug : null;
}

/** Validate a custom room name. Empty is fine — naming a room is optional. */
export function validateRoomDisplayName(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed.length > MAX_ROOM_DISPLAY_NAME_LENGTH) {
		return `Keep it to ${MAX_ROOM_DISPLAY_NAME_LENGTH} characters or fewer.`;
	}
	if (!ROOM_DISPLAY_NAME_REGEX.test(trimmed)) {
		return 'Use only letters, numbers, spaces, hyphens and underscores.';
	}
	return null;
}
