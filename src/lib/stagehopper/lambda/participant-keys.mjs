const LEGACY_UUID_PATTERN = /^[0-9a-f-]{36}$/i;
const ANON_PARTICIPANT_KEY_PATTERN = /^anon:[0-9a-f-]{36}$/i;

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
export function isSupportedParticipantKey(value) {
	return isLegacyAnonymousParticipantKey(value) || isAnonymousParticipantKey(value);
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
	if (!participantKey || !isSupportedParticipantKey(participantKey)) {
		return { ok: false, statusCode: 400, error: 'Invalid participantKey' };
	}

	if (!name) {
		return { ok: false, statusCode: 400, error: 'name is required' };
	}

	return { ok: true, participantKey, name };
}
