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
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { OAuth2Client } from 'google-auth-library';
import { randomBytes } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);
const s3 = new S3Client({});
const cloudfront = new CloudFrontClient({});

const TABLE = process.env.TABLE_NAME;
const MEMBERSHIPS_TABLE = process.env.MEMBERSHIPS_TABLE_NAME;
const SITE_ORIGIN = process.env.SITE_ORIGIN;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
/** Bucket the static site (and `data/festivals.json`) is served from. */
const SITE_BUCKET = process.env.SITE_BUCKET;
/** CloudFront distribution in front of {@link SITE_BUCKET}, invalidated after a write. */
const CF_DISTRIBUTION_ID = process.env.CF_DISTRIBUTION_ID;

const googleAuthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

/**
 * Admin allowlist, by verified Google email.
 *
 * Set by hand on the Lambda rather than through a GitHub secret: `deploy.yml` only calls
 * `update-function-code`, and `update-function-configuration` replaces the entire
 * environment map, so wiring it into CI would silently wipe `TABLE_NAME` and friends.
 */
const ADMIN_EMAILS = new Set(
	(process.env.ADMIN_EMAILS ?? '')
		.split(',')
		.map((email) => email.trim().toLowerCase())
		.filter((email) => email.length > 0)
);

if (ADMIN_EMAILS.size === 0) {
	// Fail closed. Safe, but otherwise silent — a misconfigured deploy would look like a
	// permissions bug to whoever is locked out.
	console.warn('ADMIN_EMAILS is unset or empty; no account can reach the admin routes.');
}

/**
 * Either a festival-prefixed id (`ps26-abc123`) or a custom slug (3-40 chars,
 * alphanumeric + hyphens) for vanity rooms created through the join flow.
 *
 * The prefix isn't checked against the live festival list: that would mean an S3 read
 * on every room write, and an S3 hiccup would then stop everyone from saving picks. Only
 * the shape is enforced (2-10 lowercase alphanumerics, a hyphen, 6 hex chars) — matching
 * the id length a festival record is validated against in the admin routes below.
 */
const VALID_ROOM_ID_REGEX = /^(?:[a-z0-9]{2,10}-[0-9a-f]{6}|[a-z0-9][a-z0-9-]{1,38}[a-z0-9])$/;

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
type IdentitySuccess = {
	ok: true;
	participantKey: string;
	name: string;
	/** Lowercased Google email, or empty when the token carries no email claim. */
	email: string;
	/** Google's own verification of that address. Only `true` may be acted on. */
	emailVerified: boolean;
};
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
		'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
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
const forbidden = (body: unknown) => jsonResponse(403, body);
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
		const email = typeof payload?.email === 'string' ? payload.email.trim().toLowerCase() : '';

		if (!sub) {
			return { ok: false, statusCode: 401, error: 'Invalid Google identity' };
		}
		if (requireName && !resolvedName) {
			return { ok: false, statusCode: 401, error: 'Google profile name is missing' };
		}
		return {
			ok: true,
			participantKey: `google:${sub}`,
			name: resolvedName,
			email,
			// Strictly `true`: Google sends this as a boolean, but a string "true" from any
			// other issuer must not sneak past the admin check as truthy.
			emailVerified: payload?.email_verified === true
		};
	} catch (err) {
		console.error('Google ID token verification failed:', err);
		return { ok: false, statusCode: 401, error: 'Invalid Google token' };
	}
}

/**
 * Whether a resolved identity is on the admin allowlist.
 *
 * `email_verified` is mandatory. Without it the address is just a string the account
 * holder picked, so anyone could claim an admin email and the gate would be decorative.
 */
export function isAdminIdentity(identity: ResolvedIdentity): boolean {
	if (!identity.ok || !identity.emailVerified || !identity.email) return false;
	return ADMIN_EMAILS.has(identity.email);
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
 * Report whether the caller may use the admin console.
 *
 * The token travels in the body, like `POST /users/me/rooms`, so no extra CORS header has
 * to be allowed. This answer only decides whether the admin UI is worth rendering — the
 * bundle is static and can be edited by anyone, so every admin route enforces for itself.
 */
async function getAdminStatus(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
	const { parsed, error: parseError } = parseJsonBody(event.body);
	if (parseError) return badRequest(parseError);

	const { error: tokenError, googleIdToken } = extractGoogleIdToken(parsed);
	if (tokenError || !googleIdToken) return badRequest(tokenError ?? 'googleIdToken is required');

	const identity = await resolveGoogleIdentity(googleIdToken, '', { requireName: false });
	if (!identity.ok) return identityErrorResponse(identity);

	// 403, not 401: the token is fine, so re-authenticating would only loop.
	if (!isAdminIdentity(identity)) return forbidden({ isAdmin: false, error: 'Not an admin' });

	return ok({ isAdmin: true });
}

// ---- Admin: festivals ----

/** `data/festivals.json`'s key in {@link SITE_BUCKET}; also its public CloudFront path. */
const FESTIVALS_S3_KEY = 'data/festivals.json';

const FESTIVAL_ID_REGEX = /^[a-z0-9]{2,10}$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

interface FestivalRecord {
	id: string;
	name: string;
	location: string;
	startDate: string;
	endDate: string;
	accent: string;
	emoji: string;
	imageUrl?: string;
}

interface ValidatedFestivalsBody {
	festivals: FestivalRecord[];
	googleIdToken: string;
}

/**
 * Every non-empty string field is trimmed-non-empty, not merely present: an admin
 * pasting a blank name or accent would otherwise silently break the landing page for
 * every visitor, not just the person who made the mistake.
 */
function validateFestivalRecord(value: unknown): string | null {
	if (!value || typeof value !== 'object') return 'each festival must be an object';
	const r = value as Record<string, unknown>;

	if (typeof r.id !== 'string' || !FESTIVAL_ID_REGEX.test(r.id)) {
		return 'festival id must be 2-10 lowercase letters/digits';
	}
	if (typeof r.name !== 'string' || r.name.trim().length === 0) return 'name is required';
	if (typeof r.location !== 'string' || r.location.trim().length === 0) return 'location is required';
	if (typeof r.startDate !== 'string' || !ISO_DATE_REGEX.test(r.startDate)) {
		return 'startDate must be an ISO date (YYYY-MM-DD)';
	}
	if (typeof r.endDate !== 'string' || !ISO_DATE_REGEX.test(r.endDate)) {
		return 'endDate must be an ISO date (YYYY-MM-DD)';
	}
	if (r.startDate > r.endDate) return 'startDate must not be after endDate';
	if (typeof r.accent !== 'string' || r.accent.trim().length === 0) return 'accent is required';
	if (typeof r.emoji !== 'string' || r.emoji.trim().length === 0) return 'emoji is required';
	if (r.imageUrl !== undefined && typeof r.imageUrl !== 'string') return 'imageUrl must be a string';
	return null;
}

/** Validate and sanitize a `PUT /admin/festivals` request body. */
export function validateFestivalsBody(raw: unknown): {
	data?: ValidatedFestivalsBody;
	error?: string;
} {
	const { parsed, error: parseError } = parseJsonBody(raw);
	if (parseError) return { error: parseError };

	const { error: tokenError, googleIdToken } = extractGoogleIdToken(parsed);
	if (tokenError || !googleIdToken) return { error: tokenError ?? 'googleIdToken is required' };

	const festivals = (parsed as { festivals?: unknown } | null)?.festivals;
	if (!Array.isArray(festivals)) return { error: 'festivals must be an array' };
	if (festivals.length === 0) return { error: 'festivals must not be empty' };

	const seenIds = new Set<string>();
	for (const entry of festivals) {
		const recordError = validateFestivalRecord(entry);
		if (recordError) return { error: recordError };

		const id = (entry as FestivalRecord).id;
		if (seenIds.has(id)) return { error: `duplicate festival id: ${id}` };
		seenIds.add(id);
	}

	return { data: { festivals: festivals as FestivalRecord[], googleIdToken } };
}

/**
 * Replace the published festival list.
 *
 * Reading the current list is a plain public fetch of `/data/festivals.json` (the same
 * path the landing page uses) — there is no `GET /admin/festivals` route, since a
 * Google id token can't travel on a GET without a body, which `fetch` refuses to send.
 */
async function putAdminFestivals(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
	const validated = validateFestivalsBody(event.body);
	if (validated.error || !validated.data) return badRequest(validated.error ?? 'Invalid request body');

	const identity = await resolveGoogleIdentity(validated.data.googleIdToken, '', {
		requireName: false
	});
	if (!identity.ok) return identityErrorResponse(identity);
	if (!isAdminIdentity(identity)) return forbidden({ error: 'Not an admin' });

	try {
		await s3.send(
			new PutObjectCommand({
				Bucket: SITE_BUCKET,
				Key: FESTIVALS_S3_KEY,
				Body: JSON.stringify(validated.data.festivals),
				ContentType: 'application/json'
			})
		);

		// Best-effort: a missed invalidation just means edges catch up on their own TTL —
		// worth logging, not worth failing an otherwise-successful write over.
		if (CF_DISTRIBUTION_ID) {
			try {
				await cloudfront.send(
					new CreateInvalidationCommand({
						DistributionId: CF_DISTRIBUTION_ID,
						InvalidationBatch: {
							CallerReference: `festivals-${Date.now()}`,
							Paths: { Quantity: 1, Items: [`/${FESTIVALS_S3_KEY}`] }
						}
					})
				);
			} catch (err) {
				console.error('Festivals saved, but the CloudFront invalidation failed:', err);
			}
		}

		return ok({ ok: true, festivals: validated.data.festivals });
	} catch (err) {
		console.error('Failed to write festivals to S3:', err);
		return serverError();
	}
}

// ---- Admin: festival images ----

/**
 * Allowed upload content types, mapped to the extension their key gets. Anything else
 * is refused before a presigned URL is ever minted — the UI's own `accept` filter is
 * just a hint, this is the rule.
 */
const ALLOWED_IMAGE_CONTENT_TYPES: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp'
};

/** Comfortably above a downscaled cover image, well under an unresized phone photo. */
const MAX_IMAGE_BYTES = 5_000_000;

/** How long an admin has to actually perform the PUT before the signature expires. */
const IMAGE_UPLOAD_URL_TTL_SECONDS = 300;

/**
 * Presign a direct-to-S3 upload for a festival's cover image.
 *
 * Bytes never pass through this Lambda — no API Gateway payload ceiling, no base64
 * inflation. `ContentType` and `ContentLength` are baked into the signed request itself
 * (not just checked here and forgotten): S3 rejects the browser's PUT outright if either
 * doesn't match exactly what was validated, so the constraint holds even though the
 * Lambda never sees the bytes. The key includes a random suffix rather than the
 * `id` alone, so replacing an image is a new key — nothing needs invalidating, the old
 * object is simply orphaned.
 */
async function presignFestivalImageUpload(
	event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
	const festivalId = event.pathParameters?.id;
	if (!festivalId || !FESTIVAL_ID_REGEX.test(festivalId)) return badRequest('Invalid festival id');

	const { parsed, error: parseError } = parseJsonBody(event.body);
	if (parseError) return badRequest(parseError);

	const { error: tokenError, googleIdToken } = extractGoogleIdToken(parsed);
	if (tokenError || !googleIdToken) return badRequest(tokenError ?? 'googleIdToken is required');

	const body = parsed as { contentType?: unknown; contentLength?: unknown } | null;
	const contentType = body?.contentType;
	const contentLength = body?.contentLength;

	if (typeof contentType !== 'string' || !(contentType in ALLOWED_IMAGE_CONTENT_TYPES)) {
		return badRequest('contentType must be one of: ' + Object.keys(ALLOWED_IMAGE_CONTENT_TYPES).join(', '));
	}
	if (
		typeof contentLength !== 'number' ||
		!Number.isInteger(contentLength) ||
		contentLength <= 0 ||
		contentLength > MAX_IMAGE_BYTES
	) {
		return badRequest(`contentLength must be a positive integer up to ${MAX_IMAGE_BYTES} bytes`);
	}

	const identity = await resolveGoogleIdentity(googleIdToken, '', { requireName: false });
	if (!identity.ok) return identityErrorResponse(identity);
	if (!isAdminIdentity(identity)) return forbidden({ error: 'Not an admin' });

	const extension = ALLOWED_IMAGE_CONTENT_TYPES[contentType];
	const key = `data/festival-images/${festivalId}-${randomBytes(8).toString('hex')}.${extension}`;

	try {
		const uploadUrl = await getSignedUrl(
			s3,
			new PutObjectCommand({
				Bucket: SITE_BUCKET,
				Key: key,
				ContentType: contentType,
				ContentLength: contentLength
			}),
			{ expiresIn: IMAGE_UPLOAD_URL_TTL_SECONDS }
		);

		return ok({ uploadUrl, imageUrl: `/${key}` });
	} catch (err) {
		console.error('Failed to presign a festival image upload:', err);
		return serverError();
	}
}

// ---- Admin: timetable import ----

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

interface TimetableImportPerformance {
	id: string;
	artist: string;
	stage: string;
	startTime: string;
	endTime: string;
	artists?: unknown;
	artistImage?: unknown;
	instagram?: unknown;
}

interface TimetableImportDay {
	date: string;
	performances: TimetableImportPerformance[];
}

interface TimetableImportPayload {
	formatVersion: 1;
	festivalId: string;
	days: TimetableImportDay[];
}

/**
 * Validate a timetable import payload against the canonical v1 shape. Mirrors the
 * client's `validateTimetableImport` (there's no shared module — separate projects) —
 * the client is untrusted, so this is the rule, not the hint.
 */
export function validateTimetableImportPayload(raw: unknown): {
	data?: TimetableImportPayload;
	error?: string;
} {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { error: 'timetable must be an object' };
	}
	const obj = raw as Record<string, unknown>;

	if (obj.formatVersion !== 1) return { error: 'formatVersion must be 1' };
	if (typeof obj.festivalId !== 'string' || obj.festivalId.trim().length === 0) {
		return { error: 'festivalId is required' };
	}
	if (!Array.isArray(obj.days) || obj.days.length === 0) {
		return { error: 'days must be a non-empty array' };
	}

	const seenIds = new Set<string>();
	for (const rawDay of obj.days) {
		if (!rawDay || typeof rawDay !== 'object') return { error: 'each day must be an object' };
		const day = rawDay as Record<string, unknown>;

		if (typeof day.date !== 'string' || !ISO_DATE_REGEX.test(day.date)) {
			return { error: 'each day needs an ISO date (YYYY-MM-DD)' };
		}
		if (!Array.isArray(day.performances)) return { error: 'each day needs a performances array' };

		for (const rawPerf of day.performances) {
			if (!rawPerf || typeof rawPerf !== 'object') return { error: 'each performance must be an object' };
			const perf = rawPerf as Record<string, unknown>;

			if (typeof perf.id !== 'string' || perf.id.trim().length === 0) {
				return { error: 'every performance needs an id' };
			}
			if (seenIds.has(perf.id)) return { error: `duplicate performance id: ${perf.id}` };
			seenIds.add(perf.id);

			if (typeof perf.artist !== 'string' || perf.artist.trim().length === 0) {
				return { error: 'every performance needs an artist' };
			}
			if (typeof perf.stage !== 'string' || perf.stage.trim().length === 0) {
				return { error: 'every performance needs a stage' };
			}
			if (typeof perf.startTime !== 'string' || !TIME_REGEX.test(perf.startTime)) {
				return { error: 'startTime must be HH:MM' };
			}
			if (typeof perf.endTime !== 'string' || !TIME_REGEX.test(perf.endTime)) {
				return { error: 'endTime must be HH:MM' };
			}
		}
	}

	return { data: obj as unknown as TimetableImportPayload };
}

function timetableS3Key(festivalId: string): string {
	return `data/timetable-${festivalId}.json`;
}

function s3ErrorStatus(err: unknown): { name?: string; status?: number } {
	return {
		name: (err as { name?: string })?.name,
		status: (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
	};
}

function isS3NotFoundError(err: unknown): boolean {
	const { name, status } = s3ErrorStatus(err);
	return name === 'NotFound' || name === 'NoSuchKey' || status === 404;
}

/** Thrown by `PutObjectCommand` when `IfMatch` no longer matches the object's ETag. */
function isS3PreconditionFailedError(err: unknown): boolean {
	const { name, status } = s3ErrorStatus(err);
	return name === 'PreconditionFailed' || status === 412;
}

async function timetableAlreadyExists(key: string): Promise<boolean> {
	try {
		await s3.send(new HeadObjectCommand({ Bucket: SITE_BUCKET, Key: key }));
		return true;
	} catch (err) {
		if (isS3NotFoundError(err)) return false;
		throw err;
	}
}

/**
 * Import a festival's timetable — write-once, at festival creation only. No re-import,
 * no diffing, no merge: selections are keyed by performance id, and a re-keyed feed
 * would silently orphan every existing pick with no error. Post-creation changes are
 * per-card edits (a later issue), not a second import.
 */
async function importFestivalTimetable(
	event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
	const festivalId = event.pathParameters?.id;
	if (!festivalId || !FESTIVAL_ID_REGEX.test(festivalId)) return badRequest('Invalid festival id');

	const { parsed, error: parseError } = parseJsonBody(event.body);
	if (parseError) return badRequest(parseError);

	const { error: tokenError, googleIdToken } = extractGoogleIdToken(parsed);
	if (tokenError || !googleIdToken) return badRequest(tokenError ?? 'googleIdToken is required');

	const validated = validateTimetableImportPayload(
		(parsed as { timetable?: unknown } | null)?.timetable
	);
	if (validated.error || !validated.data) return badRequest(validated.error ?? 'Invalid timetable');
	if (validated.data.festivalId !== festivalId) {
		return badRequest('festivalId in the file does not match the festival being imported into');
	}

	const identity = await resolveGoogleIdentity(googleIdToken, '', { requireName: false });
	if (!identity.ok) return identityErrorResponse(identity);
	if (!isAdminIdentity(identity)) return forbidden({ error: 'Not an admin' });

	const key = timetableS3Key(festivalId);

	try {
		if (await timetableAlreadyExists(key)) {
			return jsonResponse(409, { error: 'A timetable already exists for this festival' });
		}
	} catch (err) {
		console.error('Failed to check for an existing timetable:', err);
		return serverError();
	}

	try {
		await s3.send(
			new PutObjectCommand({
				Bucket: SITE_BUCKET,
				Key: key,
				Body: JSON.stringify(validated.data),
				ContentType: 'application/json'
			})
		);

		if (CF_DISTRIBUTION_ID) {
			try {
				await cloudfront.send(
					new CreateInvalidationCommand({
						DistributionId: CF_DISTRIBUTION_ID,
						InvalidationBatch: {
							CallerReference: `timetable-${festivalId}-${Date.now()}`,
							Paths: { Quantity: 1, Items: [`/${key}`] }
						}
					})
				);
			} catch (err) {
				console.error('Timetable saved, but the CloudFront invalidation failed:', err);
			}
		}

		return ok({ ok: true });
	} catch (err) {
		console.error('Failed to write timetable to S3:', err);
		return serverError();
	}
}

// ---- Admin: per-performance timetable editing ----

const EDITABLE_PERFORMANCE_FIELDS = new Set([
	'artist',
	'stage',
	'startTime',
	'endTime',
	'artistImage',
	'instagram'
]);
const REQUIRED_ON_ADD = ['artist', 'stage', 'startTime', 'endTime'] as const;

/** Reject anything not in `allowedKeys`, then type/format-check whichever fields are present. */
function validatePatchFields(patch: Record<string, unknown>, allowedKeys: Set<string>): string | null {
	for (const key of Object.keys(patch)) {
		if (!allowedKeys.has(key)) return `unknown field: ${key}`;
	}
	if ('artist' in patch && (typeof patch.artist !== 'string' || patch.artist.trim().length === 0)) {
		return 'artist must be a non-empty string';
	}
	if ('stage' in patch && (typeof patch.stage !== 'string' || patch.stage.trim().length === 0)) {
		return 'stage must be a non-empty string';
	}
	if ('startTime' in patch && (typeof patch.startTime !== 'string' || !TIME_REGEX.test(patch.startTime))) {
		return 'startTime must be HH:MM';
	}
	if ('endTime' in patch && (typeof patch.endTime !== 'string' || !TIME_REGEX.test(patch.endTime))) {
		return 'endTime must be HH:MM';
	}
	if ('artistImage' in patch && typeof patch.artistImage !== 'string') {
		return 'artistImage must be a string';
	}
	if ('instagram' in patch && typeof patch.instagram !== 'string') {
		return 'instagram must be a string';
	}
	return null;
}

function buildPerformanceFromPatch(id: string, patch: Record<string, unknown>): TimetableImportPerformance {
	return {
		id,
		artist: patch.artist as string,
		stage: patch.stage as string,
		startTime: patch.startTime as string,
		endTime: patch.endTime as string,
		...(typeof patch.artistImage === 'string' && { artistImage: patch.artistImage }),
		...(typeof patch.instagram === 'string' && { instagram: patch.instagram })
	};
}

/**
 * Apply one performance-scoped edit to a timetable already known to be well-formed.
 *
 * The op is inferred from whether `performanceId` already exists, matching the body
 * shape the issue specifies (`{ performanceId, patch }`, no separate `op` field):
 * exists + `patch: null` → delete; exists + object → update in place; doesn't exist +
 * object with every required field → add, placed under `patch.date`.
 */
function applyTimetablePatch(
	timetable: TimetableImportPayload,
	performanceId: string,
	patch: unknown
): { data?: TimetableImportPayload; error?: string } {
	let dayIndex = -1;
	let perfIndex = -1;
	timetable.days.forEach((day, dIdx) => {
		const pIdx = day.performances.findIndex((p) => p.id === performanceId);
		if (pIdx !== -1) {
			dayIndex = dIdx;
			perfIndex = pIdx;
		}
	});
	const exists = dayIndex !== -1;

	if (patch === null) {
		if (!exists) return { error: `no performance with id: ${performanceId}` };
		const days = timetable.days.map((day, idx) =>
			idx === dayIndex
				? { ...day, performances: day.performances.filter((p) => p.id !== performanceId) }
				: day
		);
		return { data: { ...timetable, days } };
	}

	if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
		return { error: 'patch must be an object, or null to delete' };
	}
	const patchObj = patch as Record<string, unknown>;

	if (!exists) {
		const fieldError = validatePatchFields(patchObj, new Set([...EDITABLE_PERFORMANCE_FIELDS, 'date']));
		if (fieldError) return { error: fieldError };
		for (const field of REQUIRED_ON_ADD) {
			if (typeof patchObj[field] !== 'string') return { error: `${field} is required` };
		}
		if (typeof patchObj.date !== 'string' || !ISO_DATE_REGEX.test(patchObj.date)) {
			return { error: 'date must be an ISO date (YYYY-MM-DD) when adding a performance' };
		}

		const newPerformance = buildPerformanceFromPatch(performanceId, patchObj);
		const targetDayIndex = timetable.days.findIndex((day) => day.date === patchObj.date);
		const days =
			targetDayIndex === -1
				? [...timetable.days, { date: patchObj.date, performances: [newPerformance] }]
				: timetable.days.map((day, idx) =>
						idx === targetDayIndex
							? { ...day, performances: [...day.performances, newPerformance] }
							: day
					);
		return { data: { ...timetable, days } };
	}

	if (Object.keys(patchObj).length === 0) return { error: 'patch must include at least one field' };
	const fieldError = validatePatchFields(patchObj, EDITABLE_PERFORMANCE_FIELDS);
	if (fieldError) return { error: fieldError };

	const days = timetable.days.map((day, dIdx) =>
		dIdx !== dayIndex
			? day
			: {
					...day,
					performances: day.performances.map((perf, pIdx) =>
						pIdx !== perfIndex ? perf : { ...perf, ...patchObj }
					)
				}
	);
	return { data: { ...timetable, days } };
}

/**
 * Edit, add or delete one performance — read-modify-write with a conditional PUT.
 *
 * The client sends only the patch, never the ~300KB file; validation of both the patch
 * and the stored timetable stays server-side. `IfMatch` on the write means a stale edit
 * (someone else saved between this GET and this PUT) fails with 412 instead of silently
 * clobbering the other admin's change — there's no locking, the client just retries.
 */
async function patchFestivalTimetable(
	event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
	const festivalId = event.pathParameters?.id;
	if (!festivalId || !FESTIVAL_ID_REGEX.test(festivalId)) return badRequest('Invalid festival id');

	const { parsed, error: parseError } = parseJsonBody(event.body);
	if (parseError) return badRequest(parseError);

	const { error: tokenError, googleIdToken } = extractGoogleIdToken(parsed);
	if (tokenError || !googleIdToken) return badRequest(tokenError ?? 'googleIdToken is required');

	const body = parsed as { performanceId?: unknown; patch?: unknown } | null;
	if (typeof body?.performanceId !== 'string' || body.performanceId.trim().length === 0) {
		return badRequest('performanceId is required');
	}
	if (!body || !('patch' in body)) {
		return badRequest('patch is required (null to delete a performance)');
	}
	const { performanceId, patch } = body;

	const identity = await resolveGoogleIdentity(googleIdToken, '', { requireName: false });
	if (!identity.ok) return identityErrorResponse(identity);
	if (!isAdminIdentity(identity)) return forbidden({ error: 'Not an admin' });

	const key = timetableS3Key(festivalId);

	let current: TimetableImportPayload;
	let etag: string | undefined;
	try {
		const result = await s3.send(new GetObjectCommand({ Bucket: SITE_BUCKET, Key: key }));
		etag = result.ETag;
		const text = (await result.Body?.transformToString()) ?? '';
		const validated = validateTimetableImportPayload(JSON.parse(text));
		if (validated.error || !validated.data) {
			console.error('Stored timetable failed re-validation:', validated.error);
			return serverError();
		}
		current = validated.data;
	} catch (err) {
		if (isS3NotFoundError(err)) return notFound();
		console.error('Failed to read the timetable for editing:', err);
		return serverError();
	}

	const applied = applyTimetablePatch(current, performanceId, patch);
	if (applied.error || !applied.data) return badRequest(applied.error ?? 'Invalid patch');

	try {
		await s3.send(
			new PutObjectCommand({
				Bucket: SITE_BUCKET,
				Key: key,
				Body: JSON.stringify(applied.data),
				ContentType: 'application/json',
				IfMatch: etag
			})
		);
	} catch (err) {
		if (isS3PreconditionFailedError(err)) {
			return jsonResponse(412, {
				error: 'The timetable changed since you loaded it. Reload and try again.'
			});
		}
		console.error('Failed to write the patched timetable:', err);
		return serverError();
	}

	if (CF_DISTRIBUTION_ID) {
		try {
			await cloudfront.send(
				new CreateInvalidationCommand({
					DistributionId: CF_DISTRIBUTION_ID,
					InvalidationBatch: {
						CallerReference: `timetable-patch-${festivalId}-${Date.now()}`,
						Paths: { Quantity: 1, Items: [`/${key}`] }
					}
				})
			);
		} catch (err) {
			console.error('Timetable patched, but the CloudFront invalidation failed:', err);
		}
	}

	return ok({ ok: true, timetable: applied.data });
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
			case 'POST /api/stagehopper/admin/me':
				return await getAdminStatus(event);
			case 'PUT /api/stagehopper/admin/festivals':
				return await putAdminFestivals(event);
			case 'POST /api/stagehopper/admin/festivals/{id}/image-upload':
				return await presignFestivalImageUpload(event);
			case 'POST /api/stagehopper/admin/festivals/{id}/timetable-import':
				return await importFestivalTimetable(event);
			case 'PATCH /api/stagehopper/admin/festivals/{id}/timetable':
				return await patchFestivalTimetable(event);
			default:
				return notFound();
		}
	} catch (err) {
		console.error('StageHopper Lambda error:', err);
		return serverError();
	}
};
