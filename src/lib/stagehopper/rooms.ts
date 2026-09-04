/**
 * @file Room id generation and parsing.
 */

import { getLatestFestival } from './festivals.svelte.js';

/**
 * A room id owned by a festival, e.g. `tmr26-1f4c9a`.
 *
 * A shape, not a list of festivals. The enumerated `(ps26|tmr26)` this replaces predated
 * the admin UI, so no festival added since was recognised here — it fell through to the
 * slug branch below, which happened to return a well-formed room id unchanged and so hid
 * the bug entirely. That only holds while slugifying and the room-id shape agree; a longer
 * slug cap or a different separator would have separated them, silently. This mirrors
 * VALID_ROOM_ID_REGEX's festival arm in lambda/index.ts, which is the real authority.
 */
const FESTIVAL_ROOM_ID_PATTERN = /^[a-z0-9]{2,10}-[0-9a-f]{6}$/i;
/** The random suffix on its own, as typed by someone reading it off a screen. */
const BARE_HEX_PATTERN = /^[0-9a-f]{6}$/i;
/** Custom room names are slugs; the backend enforces the same shape. */
const MAX_SLUG_LENGTH = 40;
const MIN_SLUG_LENGTH = 3;

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

	// Lower-cased on the way out: the backend's ids are lowercase, and someone typing one
	// off a screen in caps used to be rescued by slugify() on the branch below.
	if (FESTIVAL_ROOM_ID_PATTERN.test(candidate)) {
		return candidate.toLowerCase();
	}
	if (BARE_HEX_PATTERN.test(candidate)) {
		return `${getLatestFestival().prefix}${candidate.toLowerCase()}`;
	}

	const slug = slugify(candidate);
	return slug.length >= MIN_SLUG_LENGTH ? slug : null;
}

/**
 * Longest a custom room display name may be — a friendly label set at creation, entirely
 * separate from the room's id/slug above. Also enforced server-side (see
 * MAX_ROOM_DISPLAY_NAME_LENGTH in lambda/index.ts).
 */
export const MAX_ROOM_DISPLAY_NAME_LENGTH = 15;
/** Letters, digits, spaces, hyphens and underscores — mirrors the Lambda's validation. */
const ROOM_DISPLAY_NAME_PATTERN = /^[A-Za-z0-9 _-]+$/;

/** Validate a custom room name. Empty is fine — naming a room is optional. */
export function validateRoomDisplayName(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed.length > MAX_ROOM_DISPLAY_NAME_LENGTH) {
		return `Keep it to ${MAX_ROOM_DISPLAY_NAME_LENGTH} characters or fewer.`;
	}
	if (!ROOM_DISPLAY_NAME_PATTERN.test(trimmed)) {
		return 'Use only letters, numbers, spaces, hyphens and underscores.';
	}
	return null;
}

/**
 * Reserved participant key for a room's optional display name — mirrors the Lambda's
 * ROOM_NAME_USER_ID. The name travels as an extra row under the room's own partition key
 * rather than a separate endpoint, so every place that reads a room's rows sees it and
 * has to know to pull it out.
 */
const ROOM_NAME_USER_ID = '@room';

interface RawRoomItem {
	userId?: unknown;
	displayName?: unknown;
}

/**
 * Split a room's raw rows (as `GET /rooms/{roomId}/selections` returns them) into the
 * real participant rows and the room's optional display name.
 */
export function extractRoomDisplayName<T extends RawRoomItem>(
	items: readonly T[]
): { participants: T[]; displayName: string | null } {
	let displayName: string | null = null;
	const participants: T[] = [];
	for (const item of items) {
		if (item.userId === ROOM_NAME_USER_ID) {
			if (typeof item.displayName === 'string') displayName = item.displayName;
			continue;
		}
		participants.push(item);
	}
	return { participants, displayName };
}
