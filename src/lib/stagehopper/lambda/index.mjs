import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { randomBytes } from 'crypto';

import { resolveWriteIdentity } from './participant-keys.mjs';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const TABLE = process.env.TABLE_NAME;
const SITE_ORIGIN = process.env.SITE_ORIGIN;

const VALID_ROOM_ID_REGEX = /^(ps26|tmr26)-[0-9a-f]{6}$/;


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
		'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
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

/** Validate and sanitize a selections write request body. */
function validatePutBody(raw) {
	let parsed;
	try {
		parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
	} catch {
		return { error: 'Invalid JSON body' };
	}

	const { name, color, selections, participantKey } = parsed ?? {};
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
	if (
		participantKey !== undefined &&
		(typeof participantKey !== 'string' || participantKey.length === 0)
	) {
		return { error: 'participantKey must be a non-empty string' };
	}
	if (name !== undefined && typeof name !== 'string') {
		return { error: 'name must be a string' };
	}

	return {
		data: {
			name: typeof name === 'string' ? name.trim().substring(0, 50) : '',
			color,
			selections,
			participantKey: participantKey ?? ''
		}
	};
}

/**
 * @param {import('@aws-lambda-powertools/parser/types').APIGatewayProxyEventV2 | any} event
 * @param {string} [pathParticipantKey]
 */
async function upsertSelections(event, pathParticipantKey = '') {
	const roomId = event.pathParameters?.roomId;
	if (!roomId || !VALID_ROOM_ID_REGEX.test(roomId)) {
		return badRequest(event, 'Invalid roomId');
	}

	const validated = validatePutBody(event.body);
	if (validated.error) {
		return badRequest(event, validated.error);
	}

	const participantKey = pathParticipantKey || validated.data.participantKey;
	const resolvedIdentity = resolveWriteIdentity({
		participantKey,
		name: validated.data.name
	});

	if (!resolvedIdentity.ok) {
		return resolvedIdentity.statusCode === 401
			? unauthorized(event, resolvedIdentity.error)
			: badRequest(event, resolvedIdentity.error);
	}

	await ddb.send(
		new PutCommand({
			TableName: TABLE,
			Item: {
				roomId,
				userId: resolvedIdentity.participantKey,
				name: resolvedIdentity.name,
				color: validated.data.color,
				selections: validated.data.selections
			}
		})
	);

	return ok(event, {
		ok: true,
		participantKey: resolvedIdentity.participantKey,
		name: resolvedIdentity.name
	});
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

		if (routeKey === 'PUT /api/stagehopper/rooms/{roomId}/selections/{userId}') {
			return upsertSelections(event, pathParameters?.userId ?? '');
		}

		if (routeKey === 'PUT /api/stagehopper/rooms/{roomId}/selections') {
			return upsertSelections(event);
		}

		return jsonResponse(event, 404, { error: 'Not found' });
	} catch (err) {
		console.error('StageHopper Lambda error:', err);
		return serverError(event);
	}
};
