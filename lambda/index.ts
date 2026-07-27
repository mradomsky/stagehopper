/**
 * @file StageHopper API Lambda.
 *
 * Fronted by API Gateway (HTTP API, payload v2). Two DynamoDB tables back it:
 * `TABLE_NAME` holds a room's selections keyed by (roomId, userId), and
 * `MEMBERSHIPS_TABLE_NAME` holds the inverse (userId, roomId) so a user can list
 * their rooms. Both are written in one transaction so they cannot drift.
 *
 * Every mutating route requires a Google ID token, verified server-side; the client's
 * claim of who it is never counts.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { OAuth2Client } from 'google-auth-library';
import { randomBytes } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const TABLE = process.env.TABLE_NAME;
const MEMBERSHIPS_TABLE = process.env.MEMBERSHIPS_TABLE_NAME;
const SITE_ORIGIN = process.env.SITE_ORIGIN;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const googleAuthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

/**
 * Either a festival-prefixed id (`ps26-abc123`) or a custom slug (3-40 chars,
 * alphanumeric + hyphens) for vanity rooms created through the join flow.
 */
const VALID_ROOM_ID_REGEX = /^(?:(?:ps26|tmr26)-[0-9a-f]{6}|[a-z0-9][a-z0-9-]{1,38}[a-z0-9])$/;

const MAX_NAME_LENGTH = 50;
const MAX_SELECTION_KEY_LENGTH = 100;
/** A festival has a few thousand performances, so this is far above any honest client. */
const MAX_SELECTION_ENTRIES = 5000;
/**
 * DynamoDB rejects items over 400 KB. The entry count alone does not bound the item
 * (5000 keys of 100 chars is already ~500 KB), so the serialized size is checked too —
 * otherwise a hostile client turns an oversized write into a 500 instead of a 400.
 */
const MAX_SELECTIONS_BYTES = 300_000;

type SelectionState = 0 | 1 | 2;

interface ValidatedPutBody {
	name: string;
	color: string;
	selections: Record<string, SelectionState>;
	googleIdToken: string;
}

type IdentityFailure = { ok: false; statusCode: 400 | 401 | 500; error: string };
type IdentitySuccess = { ok: true; participantKey: string; name: string };
export type ResolvedIdentity = IdentitySuccess | IdentityFailure;

function truncateName(value: string): string {
	return value.trim().substring(0, MAX_NAME_LENGTH);
}

// ---- Responses ----

/**
 * Responses always advertise the configured site origin: the browser rejects the
 * response when the request came from anywhere else, which is exactly the intent.
 */
function getCorsHeaders(): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		'Access-Control-Allow-Origin': SITE_ORIGIN ?? '',
		'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Allow-Credentials': 'true'
	};
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
	return { statusCode, headers: getCorsHeaders(), body: JSON.stringify(body) };
}

const noContent = (): APIGatewayProxyResultV2 => ({
	statusCode: 200,
	headers: getCorsHeaders(),
	body: ''
});
const ok = (body: unknown) => jsonResponse(200, body);
const created = (body: unknown) => jsonResponse(201, body);
const badRequest = (message: string) => jsonResponse(400, { error: message });
const unauthorized = (message: string) => jsonResponse(401, { error: message });
const notFound = () => jsonResponse(404, { error: 'Not found' });
const serverError = () => jsonResponse(500, { error: 'Internal error' });

function identityErrorResponse(failure: IdentityFailure): APIGatewayProxyResultV2 {
	if (failure.statusCode === 401) return unauthorized(failure.error);
	if (failure.statusCode === 500) return serverError();
	return badRequest(failure.error);
}

// ---- Request parsing ----

function parseJsonBody(raw: unknown): { parsed?: unknown; error?: string } {
	try {
		return { parsed: typeof raw === 'string' ? JSON.parse(raw) : raw };
	} catch {
		return { error: 'Invalid JSON body' };
	}
}

function extractGoogleIdToken(parsed: unknown): { googleIdToken?: string; error?: string } {
	const googleIdToken = (parsed as { googleIdToken?: unknown } | null)?.googleIdToken;
	if (typeof googleIdToken !== 'string' || googleIdToken.length === 0) {
		return { error: 'googleIdToken is required' };
	}
	return { googleIdToken };
}

/** Validate and sanitize a selections write request body. */
export function validatePutBody(raw: unknown): { data?: ValidatedPutBody; error?: string } {
	const { parsed, error: parseError } = parseJsonBody(raw);
	if (parseError) return { error: parseError };

	const { error: tokenError, googleIdToken } = extractGoogleIdToken(parsed);
	if (tokenError || !googleIdToken) return { error: tokenError ?? 'googleIdToken is required' };

	const { name, color, selections } = (parsed ?? {}) as {
		name?: unknown;
		color?: unknown;
		selections?: unknown;
	};

	if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) {
		return { error: 'color must be a 6-digit hex color (#rrggbb)' };
	}
	if (!selections || typeof selections !== 'object' || Array.isArray(selections)) {
		return { error: 'selections must be an object' };
	}

	const entries = Object.entries(selections);
	if (entries.length > MAX_SELECTION_ENTRIES) {
		return { error: 'too many selections' };
	}
	if (JSON.stringify(selections).length > MAX_SELECTIONS_BYTES) {
		return { error: 'selections payload is too large' };
	}
	for (const [key, value] of entries) {
		if (key.length === 0 || key.length > MAX_SELECTION_KEY_LENGTH) {
			return { error: 'invalid selection key' };
		}
		if (value !== 0 && value !== 1 && value !== 2) {
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
			selections: selections as Record<string, SelectionState>,
			googleIdToken
		}
	};
}

// ---- Identity ----

/**
 * Verify a Google ID token and resolve the participant it identifies.
 *
 * @param clientName Display name the client asked to use; falls back to the Google profile name.
 * @param options Set `requireName: false` for operations (list/leave) that don't need a display name.
 */
export async function resolveGoogleIdentity(
	googleIdToken: string,
	clientName = '',
	{ requireName = true }: { requireName?: boolean } = {}
): Promise<ResolvedIdentity> {
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
		return { ok: true, participantKey: `google:${sub}`, name: resolvedName };
	} catch (err) {
		console.error('Google ID token verification failed:', err);
		return { ok: false, statusCode: 401, error: 'Invalid Google token' };
	}
}

// ---- Routes ----

function readRoomId(event: APIGatewayProxyEventV2): string | null {
	const roomId = event.pathParameters?.roomId;
	if (!roomId || !VALID_ROOM_ID_REGEX.test(roomId)) return null;
	return roomId;
}

async function getSelections(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
	const roomId = readRoomId(event);
	if (!roomId) return badRequest('Invalid roomId');

	const result = await ddb.send(
		new QueryCommand({
			TableName: TABLE,
			KeyConditionExpression: 'roomId = :rid',
			ExpressionAttributeValues: { ':rid': roomId }
		})
	);
	return ok(result.Items ?? []);
}

async function upsertSelections(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
	const roomId = readRoomId(event);
	if (!roomId) return badRequest('Invalid roomId');

	const validated = validatePutBody(event.body);
	if (validated.error || !validated.data) {
		return badRequest(validated.error ?? 'Invalid request body');
	}

	const identity = await resolveGoogleIdentity(validated.data.googleIdToken, validated.data.name);
	if (!identity.ok) return identityErrorResponse(identity);

	await ddb.send(
		new TransactWriteCommand({
			TransactItems: [
				{
					Put: {
						TableName: TABLE,
						Item: {
							roomId,
							userId: identity.participantKey,
							name: identity.name,
							color: validated.data.color,
							selections: validated.data.selections
						}
					}
				},
				{
					Put: {
						TableName: MEMBERSHIPS_TABLE,
						Item: {
							userId: identity.participantKey,
							roomId,
							name: identity.name,
							color: validated.data.color,
							updatedAt: Date.now()
						}
					}
				}
			]
		})
	);

	return ok({ ok: true, participantKey: identity.participantKey, name: identity.name });
}

async function listMyRooms(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
	const { parsed, error: parseError } = parseJsonBody(event.body);
	if (parseError) return badRequest(parseError);

	const { error: tokenError, googleIdToken } = extractGoogleIdToken(parsed);
	if (tokenError || !googleIdToken) return badRequest(tokenError ?? 'googleIdToken is required');

	const identity = await resolveGoogleIdentity(googleIdToken, '', { requireName: false });
	if (!identity.ok) return identityErrorResponse(identity);

	const rooms: Record<string, unknown>[] = [];
	let lastEvaluatedKey: Record<string, unknown> | undefined;
	do {
		const result = await ddb.send(
			new QueryCommand({
				TableName: MEMBERSHIPS_TABLE,
				KeyConditionExpression: 'userId = :uid',
				ExpressionAttributeValues: { ':uid': identity.participantKey },
				ExclusiveStartKey: lastEvaluatedKey
			})
		);
		rooms.push(...(result.Items ?? []));
		lastEvaluatedKey = result.LastEvaluatedKey;
	} while (lastEvaluatedKey);

	rooms.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
	return ok(rooms);
}

async function leaveRoom(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
	const roomId = readRoomId(event);
	if (!roomId) return badRequest('Invalid roomId');

	const { parsed, error: parseError } = parseJsonBody(event.body);
	if (parseError) return badRequest(parseError);

	const { error: tokenError, googleIdToken } = extractGoogleIdToken(parsed);
	if (tokenError || !googleIdToken) return badRequest(tokenError ?? 'googleIdToken is required');

	const identity = await resolveGoogleIdentity(googleIdToken, '', { requireName: false });
	if (!identity.ok) return identityErrorResponse(identity);

	await ddb.send(
		new TransactWriteCommand({
			TransactItems: [
				{ Delete: { TableName: TABLE, Key: { roomId, userId: identity.participantKey } } },
				{
					Delete: {
						TableName: MEMBERSHIPS_TABLE,
						Key: { userId: identity.participantKey, roomId }
					}
				}
			]
		})
	);

	return ok({ ok: true });
}

/**
 * Registering a room id is a no-op write: rooms materialize when their first
 * selection is saved, so this only validates and echoes the id back.
 */
function registerRoom(event: APIGatewayProxyEventV2): APIGatewayProxyResultV2 {
	let roomId: unknown = null;
	try {
		const parsed = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
		roomId = (parsed as { roomId?: unknown } | null)?.roomId ?? null;
	} catch {
		// Ignore parse errors and fall back to generating an id.
	}

	// Only a non-empty id is validated; anything absent or empty generates one.
	if (roomId && (typeof roomId !== 'string' || !VALID_ROOM_ID_REGEX.test(roomId))) {
		return badRequest('Invalid roomId format');
	}

	return created({ roomId: roomId || `ps26-${randomBytes(3).toString('hex')}` });
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
	const routeKey = event.routeKey;

	try {
		if (routeKey?.startsWith('OPTIONS ')) return noContent();

		// Each route is awaited here, not just returned: a returned promise settles
		// outside this try block, so a DynamoDB failure would escape the catch and
		// surface as a gateway error instead of the JSON 500 below.
		switch (routeKey) {
			case 'POST /api/stagehopper/rooms':
				return registerRoom(event);
			case 'GET /api/stagehopper/rooms/{roomId}/selections':
				return await getSelections(event);
			case 'PUT /api/stagehopper/rooms/{roomId}/selections':
				return await upsertSelections(event);
			case 'DELETE /api/stagehopper/rooms/{roomId}/selections':
				return await leaveRoom(event);
			case 'POST /api/stagehopper/users/me/rooms':
				return await listMyRooms(event);
			default:
				return notFound();
		}
	} catch (err) {
		console.error('StageHopper Lambda error:', err);
		return serverError();
	}
};
