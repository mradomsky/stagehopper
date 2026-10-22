/**
 * @file The rules that say when a Profile is good enough to Pick and chat, shared by the
 * Picks save and the chat so the two cannot drift.
 */

import type { AttendeeProfile } from './api.js';

/** The API's own words for a refused write; the only way to tell its 400s apart. */
const PROFILE_REFUSAL = /nickname|handle|colour/i;

/**
 * A Profile can Pick and chat once it has a Nickname and a Colour. `null` means the read has
 * not answered yet: unknown, not missing, so the caller proceeds and the server's 400 is the
 * backstop.
 */
export function isProfileComplete(profile: AttendeeProfile | null): boolean {
	return profile === null || (profile.nickname !== '' && !!profile.colour);
}

/**
 * A Picks save or a chat post the server refused for want of a Nickname or Colour. Only for
 * those write results: the Profile PUT's own 400 ("nickname must be 2 to 20…") matches too,
 * and is shown as is instead.
 */
export function profileRefused(result: { status: number; error?: string }): boolean {
	return result.status === 400 && PROFILE_REFUSAL.test(result.error ?? '');
}

/**
 * The problem with a typed Nickname, or '' when it is fine. A copy of NICKNAME_REGEX in
 * lambda/attendee.ts; the server's 400 stays the backstop if the two drift.
 */
export function nicknameProblem(raw: string): string {
	return /^[A-Za-z0-9_-]{2,20}$/.test(raw.trim())
		? ''
		: 'Nickname must be 2 to 20 characters: letters, digits, _ or -';
}
