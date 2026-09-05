/**
 * @file Room id and room naming rules — the wire contract three bundles have to agree on.
 *
 * The API Lambda validates room ids on every write, the notifier reads a festival off a room
 * id every tick, and the SPA parses ids typed by hand. All three used to declare their own
 * copy. `rooms.ts` even carried a comment naming the Lambda's regex "the real authority",
 * which is an accurate description of an unenforced mirror: nothing made the copies agree,
 * and a change to one would be found by a user rather than by the compiler.
 *
 * No runtime dependencies: this file bundles into two Lambdas and the browser.
 */

/**
 * A room id owned by a festival, e.g. `tmr26-1f4c9a`, with the festival id captured.
 *
 * A festival's room prefix is its id plus a hyphen, so the prefix *is* the festival id —
 * see {@link festivalIdFromRoomId}. Lowercase only: this is the canonical stored form. Input
 * typed by a human is lowercased before it is tested, never matched case-insensitively, so
 * there is exactly one shape here rather than one per caller.
 */
export const FESTIVAL_ROOM_ID_REGEX = /^([a-z0-9]{2,10})-[0-9a-f]{6}$/;

/** The random suffix on its own, as read off a screen and typed into the join box. */
export const BARE_ROOM_SUFFIX_REGEX = /^[0-9a-f]{6}$/;

/** A custom vanity slug, the other kind of room id. */
export const MIN_ROOM_SLUG_LENGTH = 3;
export const MAX_ROOM_SLUG_LENGTH = 40;

/**
 * Either a festival-prefixed id or a custom slug (3-40 chars, alphanumeric + hyphens).
 *
 * The prefix isn't checked against the live festival list: that would mean a read on every
 * room write, and one table's hiccup would then stop everyone from saving picks. Only the
 * shape is enforced, matching the id length a festival record is validated against.
 */
export const VALID_ROOM_ID_REGEX =
	/^(?:[a-z0-9]{2,10}-[0-9a-f]{6}|[a-z0-9][a-z0-9-]{1,38}[a-z0-9])$/;

/**
 * Which festival a room belongs to, as far as the id alone can say.
 *
 * A festival-prefixed id answers by itself, and that beats anything a client claims — not
 * only because it is free, but because a claim can be forged, and a forged one would pin
 * some other festival's re-import shut. A custom slug carries nothing, so callers that have
 * another source (a claimed id on the write path, the rooms table in the notifier) fall back
 * to it themselves. Those fallbacks differ per caller; this rule does not.
 */
export function festivalIdFromRoomId(roomId: string): string | null {
	return FESTIVAL_ROOM_ID_REGEX.exec(roomId)?.[1] ?? null;
}

/**
 * Reserved participant key for a room's optional display name, stored as an extra row under
 * the room's own partition key rather than in a separate table. No real participant key ever
 * looks like this, and every route that queries a room's rows already keys off the same
 * partition — so every reader has to know to pull it back out.
 */
export const ROOM_NAME_USER_ID = '@room';

/** Longest a custom room display name may be. Enforced on both sides of the wire. */
export const MAX_ROOM_DISPLAY_NAME_LENGTH = 15;

/** Letters, digits, spaces, hyphens and underscores. */
export const ROOM_DISPLAY_NAME_REGEX = /^[A-Za-z0-9 _-]+$/;

/**
 * Longest a participant's own display name may be. The Lambda truncates rather than
 * rejects, since this arrives from a verified token claim rather than a form.
 */
export const MAX_PARTICIPANT_NAME_LENGTH = 50;

interface RawRoomItem {
	userId?: unknown;
	displayName?: unknown;
}

/**
 * Split a room's raw rows into the real participant rows and the room's optional display
 * name. Shared because the row layout it decodes is the same fact as {@link ROOM_NAME_USER_ID}:
 * the SPA reads these rows off the API, and the Lambda writes them.
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
