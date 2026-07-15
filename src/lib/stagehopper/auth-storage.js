/**
 * @file Site-wide (not per-room) storage for the signed-in Google identity.
 */

const PREFIX = 'stagehopper:auth';

/**
 * @param {{ idToken: string; sub: string; name: string; givenName: string }} identity
 */
export function saveGoogleAuth(identity) {
	localStorage.setItem(`${PREFIX}:idToken`, identity.idToken);
	localStorage.setItem(`${PREFIX}:sub`, identity.sub);
	localStorage.setItem(`${PREFIX}:name`, identity.name);
	localStorage.setItem(`${PREFIX}:givenName`, identity.givenName);
}

/**
 * @returns {{ idToken: string; sub: string; name: string; givenName: string } | null}
 */
export function loadGoogleAuth() {
	const idToken = localStorage.getItem(`${PREFIX}:idToken`);
	const sub = localStorage.getItem(`${PREFIX}:sub`);
	const name = localStorage.getItem(`${PREFIX}:name`);
	if (!idToken || !sub || !name) return null;
	return { idToken, sub, name, givenName: localStorage.getItem(`${PREFIX}:givenName`) ?? '' };
}

export function clearGoogleAuth() {
	localStorage.removeItem(`${PREFIX}:idToken`);
	localStorage.removeItem(`${PREFIX}:sub`);
	localStorage.removeItem(`${PREFIX}:name`);
	localStorage.removeItem(`${PREFIX}:givenName`);
}
