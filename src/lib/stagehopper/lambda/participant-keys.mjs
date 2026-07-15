const LEGACY_UUID_PATTERN = /^[0-9a-f-]{36}$/i;
const ANON_PARTICIPANT_KEY_PATTERN = /^anon:[0-9a-f-]{36}$/i;
const GOOGLE_PARTICIPANT_KEY_PATTERN = /^google:[0-9]{1,255}$/;

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isLegacyAnonymousParticipantKey(value) {
	return LEGACY_UUID_PATTERN.test(value);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isAnonymousParticipantKey(value) {
	return ANON_PARTICIPANT_KEY_PATTERN.test(value);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isGoogleParticipantKey(value) {
	return GOOGLE_PARTICIPANT_KEY_PATTERN.test(value);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isSupportedParticipantKey(value) {
	return (
		isLegacyAnonymousParticipantKey(value) ||
		isAnonymousParticipantKey(value) ||
		isGoogleParticipantKey(value)
	);
}

/**
 * @param {{
 * 	participantKey: string
 * 	name: string
 * }} input
 * @returns {{
 * 	ok: true
 * 	participantKey: string
 * 	name: string
 * } | {
 * 	ok: false
 * 	statusCode: 400
 * 	error: string
 * }}
 */
export function resolveWriteIdentity({ participantKey, name }) {
	// google:<sub> keys are only ever assigned by resolveGoogleIdentity after verifying a
	// Google ID token — this unverified path must not let a caller claim one by just naming it.
	const isUnverifiedShape =
		isLegacyAnonymousParticipantKey(participantKey) || isAnonymousParticipantKey(participantKey);
	if (!participantKey || !isUnverifiedShape) {
		return { ok: false, statusCode: 400, error: 'Invalid participantKey' };
	}

	if (!name) {
		return { ok: false, statusCode: 400, error: 'name is required' };
	}

	return { ok: true, participantKey, name };
}
