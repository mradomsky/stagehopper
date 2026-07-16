import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
	DynamoDBDocumentClient,
	QueryCommand,
	TransactWriteCommand
} from '@aws-sdk/lib-dynamodb';
import { OAuth2Client } from 'google-auth-library';
import { randomBytes } from 'crypto';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const TABLE = process.env.TABLE_NAME;
const MEMBERSHIPS_TABLE = process.env.MEMBERSHIPS_TABLE_NAME;
const SITE_ORIGIN = process.env.SITE_ORIGIN;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const googleAuthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// Either a festival-prefixed id (ps26-abc123) or a custom slug (3-40 chars, alphanumeric + hyphens)
// for vanity/one-off rooms created directly through the join flow.
const VALID_ROOM_ID_REGEX = /^(?:(?:ps26|tmr26)-[0-9a-f]{6}|[a-z0-9][a-z0-9-]{1,38}[a-z0-9])$/;

/**
 * @param {string} value
 * @returns {string}
 */
function truncateName(value) {
	return value.trim().substring(0, 50);
}


/**
 * @param {{ headers?: Record<string, string | undefined> }} event
 * @returns {Record<string, string>}
 */
function getCorsHeaders(event) {
	const requestOrigin = event.headers?.origin;
	const origin = requestOrigin === SITE_ORIGIN ? requestOrigin : SITE_ORIGIN;
	return {
		'Content-Type': 'application/json',
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Allow-Credentials': 'true'
	};
}

/**
 * @param {{ headers?: Record<string, string | undefined> }} event
 * @param {number} statusCode
 * @param {unknown} body
 * @param {string[]} [cookies]
 */
function jsonResponse(event, statusCode, body, cookies = []) {
	return {
		statusCode,
		headers: getCorsHeaders(event),
		body: JSON.stringify(body),
		cookies
	};
}

/**
 * @param {{ headers?: Record<string, string | undefined> }} event
 */
function noContent(event) {
	return {
		statusCode: 200,
		headers: getCorsHeaders(event),
		body: ''
	};
}

/**
 * @param {{ headers?: Record<string, string | undefined> }} event
 * @param {unknown} body
 * @param {string[]} [cookies]
 */
function ok(event, body, cookies = []) {
	return jsonResponse(event, 200, body, cookies);
}

/**
 * @param {{ headers?: Record<string, string | undefined> }} event
 * @param {unknown} body
 */
function created(event, body) {
	return jsonResponse(event, 201, body);
}

/**
 * @param {{ headers?: Record<string, string | undefined> }} event
 * @param {string} msg
 */
function badRequest(event, msg) {
	return jsonResponse(event, 400, { error: msg });
}

/**
 * @param {{ headers?: Record<string, string | undefined> }} event
 * @param {string} msg
 */
function unauthorized(event, msg) {
	return jsonResponse(event, 401, { error: msg });
}

/**
 * @param {{ headers?: Record<string, string | undefined> }} event
 */
function serverError(event) {
	return jsonResponse(event, 500, { error: 'Internal error' });
}

/** @param {unknown} raw */
function parseJsonBody(raw) {
	try {
		return { parsed: typeof raw === 'string' ? JSON.parse(raw) : raw };
	} catch {
		return { error: 'Invalid JSON body' };
	}
}

/** @param {unknown} parsed */
function extractGoogleIdToken(parsed) {
	const googleIdToken = /** @type {any} */ (parsed)?.googleIdToken;
	if (typeof googleIdToken !== 'string' || googleIdToken.length === 0) {
		return { error: 'googleIdToken is required' };
	}
	return { googleIdToken };
}

/**
 * @param {{ headers?: Record<string, string | undefined> }} event
 * @param {{ statusCode: 400 | 401 | 500, error: string }} resolvedIdentity
 */
function identityErrorResponse(event, resolvedIdentity) {
	if (resolvedIdentity.statusCode === 401) return unauthorized(event, resolvedIdentity.error);
	if (resolvedIdentity.statusCode === 500) return serverError(event);
	return badRequest(event, resolvedIdentity.error);
}

/** Validate and sanitize a selections write request body. */
function validatePutBody(raw) {
	const { parsed, error: parseError } = parseJsonBody(raw);
	if (parseError) return { error: parseError };

	const { error: tokenError, googleIdToken } = extractGoogleIdToken(parsed);
	if (tokenError) return { error: tokenError };

	const { name, color, selections } = parsed ?? {};
	if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
		return { error: 'color must be a 6-digit hex color (#rrggbb)' };
	}
	if (!selections || typeof selections !== 'object' || Array.isArray(selections)) {
		return { error: 'selections must be an object' };
	}
	for (const [key, val] of Object.entries(selections)) {
		if (typeof key !== 'string' || key.length === 0 || key.length > 100) {
			return { error: 'invalid selection key' };
		}
		if (val !== 0 && val !== 1 && val !== 2) {
			return { error: 'selection values must be 0, 1, or 2' };
		}
	}
	if (name !== undefined && typeof name !== 'string') {
		return { error: 'name must be a string' };
	}

	return {
		data: {
			name: typeof name === 'string' ? truncateName(name) : '',
			color,
			selections,
			googleIdToken
		}
	};
}

/**
 * @param {string} googleIdToken
 * @param {string} [clientName] Display name the client asked to use; falls back to the Google profile name.
 * @param {{ requireName?: boolean }} [options] Set requireName: false for operations (list/leave) that don't need a display name.
 * @returns {Promise<{
 * 	ok: true
 * 	participantKey: string
 * 	name: string
 * } | {
 * 	ok: false
 * 	statusCode: 400 | 401 | 500
 * 	error: string
 * }>}
 */
export async function resolveGoogleIdentity(googleIdToken, clientName = '', { requireName = true } = {}) {
	if (!googleAuthClient || !GOOGLE_CLIENT_ID) {
		return { ok: false, statusCode: 500, error: 'Google auth not configured' };
	}

	try {
		const ticket = await googleAuthClient.verifyIdToken({
			idToken: googleIdToken,
			audience: GOOGLE_CLIENT_ID
		});
		const payload = ticket.getPayload();
		const sub = payload?.sub;
		const profileName = payload?.name ? truncateName(payload.name) : '';
		const resolvedName = clientName ? truncateName(clientName) : profileName;
		if (!sub) {
			return { ok: false, statusCode: 401, error: 'Invalid Google identity' };
		}
		if (requireName && !resolvedName) {
			return { ok: false, statusCode: 401, error: 'Google profile name is missing' };
		}
		return {
			ok: true,
			participantKey: `google:${sub}`,
			name: resolvedName
		};
	} catch (err) {
		console.error('Google ID token verification failed:', err);
		return { ok: false, statusCode: 401, error: 'Invalid Google token' };
	}
}

/**
 * @param {import('@aws-lambda-powertools/parser/types').APIGatewayProxyEventV2 | any} event
 */
async function upsertSelections(event) {
	const roomId = event.pathParameters?.roomId;
	if (!roomId || !VALID_ROOM_ID_REGEX.test(roomId)) {
		return badRequest(event, 'Invalid roomId');
	}

	const validated = validatePutBody(event.body);
	if (validated.error) {
		return badRequest(event, validated.error);
	}

	const resolvedIdentity = await resolveGoogleIdentity(validated.data.googleIdToken, validated.data.name);
	if (!resolvedIdentity.ok) return identityErrorResponse(event, resolvedIdentity);

	await ddb.send(
		new TransactWriteCommand({
			TransactItems: [
				{
					Put: {
						TableName: TABLE,
						Item: {
							roomId,
							userId: resolvedIdentity.participantKey,
							name: resolvedIdentity.name,
							color: validated.data.color,
							selections: validated.data.selections
						}
					}
				},
				{
					Put: {
						TableName: MEMBERSHIPS_TABLE,
						Item: {
							userId: resolvedIdentity.participantKey,
							roomId,
							name: resolvedIdentity.name,
							color: validated.data.color,
							updatedAt: Date.now()
						}
					}
				}
			]
		})
	);

	return ok(event, {
		ok: true,
		participantKey: resolvedIdentity.participantKey,
		name: resolvedIdentity.name
	});
}

/**
 * @param {import('@aws-lambda-powertools/parser/types').APIGatewayProxyEventV2 | any} event
 */
async function listMyRooms(event) {
	const { parsed, error: parseError } = parseJsonBody(event.body);
	if (parseError) return badRequest(event, parseError);

	const { error: tokenError, googleIdToken } = extractGoogleIdToken(parsed);
	if (tokenError) return badRequest(event, tokenError);

	const resolvedIdentity = await resolveGoogleIdentity(googleIdToken, '', { requireName: false });
	if (!resolvedIdentity.ok) return identityErrorResponse(event, resolvedIdentity);

	const rooms = [];
	let lastEvaluatedKey;
	do {
		const result = await ddb.send(
			new QueryCommand({
				TableName: MEMBERSHIPS_TABLE,
				KeyConditionExpression: 'userId = :uid',
				ExpressionAttributeValues: { ':uid': resolvedIdentity.participantKey },
				ExclusiveStartKey: lastEvaluatedKey
			})
		);
		rooms.push(...(result.Items ?? []));
		lastEvaluatedKey = result.LastEvaluatedKey;
	} while (lastEvaluatedKey);

	rooms.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	return ok(event, rooms);
}

/**
 * @param {import('@aws-lambda-powertools/parser/types').APIGatewayProxyEventV2 | any} event
 */
async function leaveRoom(event) {
	const roomId = event.pathParameters?.roomId;
	if (!roomId || !VALID_ROOM_ID_REGEX.test(roomId)) {
		return badRequest(event, 'Invalid roomId');
	}

	const { parsed, error: parseError } = parseJsonBody(event.body);
	if (parseError) return badRequest(event, parseError);

	const { error: tokenError, googleIdToken } = extractGoogleIdToken(parsed);
	if (tokenError) return badRequest(event, tokenError);

	const resolvedIdentity = await resolveGoogleIdentity(googleIdToken, '', { requireName: false });
	if (!resolvedIdentity.ok) return identityErrorResponse(event, resolvedIdentity);

	await ddb.send(
		new TransactWriteCommand({
			TransactItems: [
				{ Delete: { TableName: TABLE, Key: { roomId, userId: resolvedIdentity.participantKey } } },
				{
					Delete: {
						TableName: MEMBERSHIPS_TABLE,
						Key: { userId: resolvedIdentity.participantKey, roomId }
					}
				}
			]
		})
	);

	return ok(event, { ok: true });
}

export const handler = async (event) => {
	const { routeKey, pathParameters, body } = event;

	try {
		if (routeKey?.startsWith('OPTIONS ')) {
			return noContent(event);
		}

		if (routeKey === 'POST /api/stagehopper/rooms') {
			let roomId = null;
			try {
				const parsed = typeof body === 'string' ? JSON.parse(body) : body;
				roomId = parsed?.roomId;
			} catch {
				// ignore parsing errors, fall back to generation
			}

			if (roomId && !VALID_ROOM_ID_REGEX.test(roomId)) {
				return badRequest(event, 'Invalid roomId format');
			}

			const finalRoomId = roomId || `ps26-${randomBytes(3).toString('hex')}`;
			return created(event, { roomId: finalRoomId });
		}

		if (routeKey === 'GET /api/stagehopper/rooms/{roomId}/selections') {
			const roomId = pathParameters?.roomId;
			if (!roomId || !VALID_ROOM_ID_REGEX.test(roomId)) {
				return badRequest(event, 'Invalid roomId');
			}
			const result = await ddb.send(
				new QueryCommand({
					TableName: TABLE,
					KeyConditionExpression: 'roomId = :rid',
					ExpressionAttributeValues: { ':rid': roomId }
				})
			);
			return ok(event, result.Items ?? []);
		}

		if (routeKey === 'PUT /api/stagehopper/rooms/{roomId}/selections') {
			return upsertSelections(event);
		}

		if (routeKey === 'DELETE /api/stagehopper/rooms/{roomId}/selections') {
			return leaveRoom(event);
		}

		if (routeKey === 'POST /api/stagehopper/users/me/rooms') {
			return listMyRooms(event);
		}

		return jsonResponse(event, 404, { error: 'Not found' });
	} catch (err) {
		console.error('StageHopper Lambda error:', err);
		return serverError(event);
	}
};
