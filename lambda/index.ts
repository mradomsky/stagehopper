/**
 * @file StageHopper API Lambda.
 *
 * Fronted by API Gateway (HTTP API, payload v2). DynamoDB tables back it:
 * `TABLE_NAME` holds a room's selections keyed by (roomId, userId), and `USERS_TABLE`
 * holds one row per user (PK userId) with a `rooms` map — the inverse index so a user
 * can list their rooms — plus their notification settings. A join writes the selections
 * row and the user's `rooms` entry in one transaction so they cannot drift.
 * `PUSH_SUBSCRIPTIONS_TABLE` holds one Web Push subscription per device (userId, endpoint).
 *
 * Authentication happens at the gateway, not here. A JWT authorizer verifies the Clerk
 * session token on every route but `GET /rooms/{roomId}/selections`, and the admin routes
 * additionally demand an `admin` scope — so an unauthenticated or non-admin request never
 * reaches this code. What arrives is `event.requestContext.authorizer.jwt.claims`: claims
 * API Gateway verified and a client cannot forge.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
	DynamoDBDocumentClient,
	QueryCommand,
	ScanCommand,
	BatchWriteCommand,
	TransactWriteCommand,
	GetCommand,
	PutCommand,
	DeleteCommand,
	UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { randomBytes } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);
const s3 = new S3Client({});
const cloudfront = new CloudFrontClient({});
const lambda = new LambdaClient({});

const TABLE = process.env.TABLE_NAME;
/**
 * One row per user (PK userId): `{ name, email, lastActive, rooms, ...notification settings }`.
 * `rooms` is a map of roomId → `{ color, updatedAt, name }` — the user's room list and the
 * inverse of the selections table. Notification settings (`enabled`, `leadMinutes`,
 * `notifyMaybe`, `notifyOverrides`) live on the same row.
 */
const USERS_TABLE = process.env.USERS_TABLE;
/** Per-device Web Push subscriptions (PK userId, SK endpoint). */
const PUSH_SUBSCRIPTIONS_TABLE = process.env.PUSH_SUBSCRIPTIONS_TABLE;
/**
 * One row per festival (PK `id`) — the write-side source of truth for the festival list.
 * `data/festivals/index.json` in {@link SITE_BUCKET} is a derived, republished copy for the
 * public landing page and the service worker's offline cache; this table is what admin
 * writes actually hit.
 */
const FESTIVALS_TABLE = process.env.FESTIVALS_TABLE;
/**
 * One row per performance (PK `festivalId`, SK `id`) — the write-side source of truth for
 * every festival's timetable. `data/festivals/{festivalId}/timetable.json` is the derived,
 * republished copy the room page and notifier read.
 */
const PERFORMANCES_TABLE = process.env.PERFORMANCES_TABLE;
const SITE_ORIGIN = process.env.SITE_ORIGIN;
/** Bucket the static site (and the published festivals/timetable JSON) is served from. */
const SITE_BUCKET = process.env.SITE_BUCKET;
/** CloudFront distribution in front of {@link SITE_BUCKET}, invalidated after a write. */
const CF_DISTRIBUTION_ID = process.env.CF_DISTRIBUTION_ID;
/**
 * The notifier Lambda's function name — this function invokes it synchronously to send an
 * admin test push, reusing the one place that holds web-push and the VAPID keys. Defaults
 * to the deployed name so a missing env var doesn't silently break the feature.
 */
const NOTIFIER_FUNCTION_NAME = process.env.NOTIFIER_FUNCTION_NAME || 'stagehopper-notifier';

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
}

/**
 * What API Gateway delivers. `authorizer` is optional because exactly one route — the
 * public GET of a room's selections — has no authorizer attached and genuinely arrives
 * without it. Every other route is guaranteed to carry verified claims.
 */
type StagehopperEvent = APIGatewayProxyEventV2 & {
	requestContext: { authorizer?: { jwt?: { claims?: Record<string, unknown> } } };
};

/** A caller, as the gateway's verified claims describe them. */
export interface Identity {
	/** `clerk:${sub}` — PK of `users`, SK of the selections table, PK of subscriptions. */
	participantKey: string;
	/** The token's `name` claim, truncated; may be empty. */
	name: string;
	/** The token's `email` claim, lowercased; may be empty. */
	email: string;
	/** The token's `scope` claim, split on whitespace. */
	scopes: string[];
}

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
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

// ---- Request parsing ----

function parseJsonBody(raw: unknown): { parsed?: unknown; error?: string } {
	try {
		return { parsed: typeof raw === 'string' ? JSON.parse(raw) : raw };
	} catch {
		return { error: 'Invalid JSON body' };
	}
}

/** Validate and sanitize a selections write request body. */
export function validatePutBody(raw: unknown): { data?: ValidatedPutBody; error?: string } {
	const { parsed, error: parseError } = parseJsonBody(raw);
	if (parseError) return { error: parseError };

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
			selections: selections as Record<string, SelectionState>
		}
	};
}

// ---- Identity ----

/**
 * Read the caller off the claims the gateway's JWT authorizer verified and attached.
 *
 * There is no verification here and there should not be: signature, issuer, audience and
 * expiry were all checked before this function was invoked. Nothing in the request body
 * contributes — a client can name itself whatever it likes and it will not change the key
 * its data is written under.
 */
export function readIdentity(event: StagehopperEvent): Identity | null {
	const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
	const sub = claims.sub;
	if (typeof sub !== 'string' || sub.length === 0) return null;

	const scope = claims.scope;
	return {
		participantKey: `clerk:${sub}`,
		name: typeof claims.name === 'string' ? truncateName(claims.name) : '',
		email: typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '',
		scopes: typeof scope === 'string' ? scope.split(/\s+/).filter(Boolean) : []
	};
}

/**
 * The caller, or the response to send instead.
 *
 * The failure is unreachable in production — API Gateway rejects a request carrying no
 * valid token before invoking this function. It exists so a route accidentally wired
 * without an authorizer fails closed rather than writing under `clerk:undefined`.
 */
function requireIdentity(
	event: StagehopperEvent
): { identity: Identity } | { error: APIGatewayProxyResultV2 } {
	const identity = readIdentity(event);
	if (!identity) return { error: unauthorized('Unauthorized') };
	return { identity };
}

/**
 * Whether the caller carries the `admin` scope.
 *
 * Used by `GET /admin/me` alone. Every other admin route is gated by
 * `authorization_scopes = ["admin"]` on its `aws_apigatewayv2_route`, so re-checking here
 * would put one rule in two places and let them disagree. This route is deliberately *not*
 * scope-gated, because answering "no" to a non-admin is its entire purpose.
 */
export function hasAdminScope(identity: Identity): boolean {
	return identity.scopes.includes('admin');
}

// ---- Routes ----

function readRoomId(event: StagehopperEvent): string | null {
	const roomId = event.pathParameters?.roomId;
	if (!roomId || !VALID_ROOM_ID_REGEX.test(roomId)) return null;
	return roomId;
}

async function getSelections(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
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

async function upsertSelections(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const roomId = readRoomId(event);
	if (!roomId) return badRequest('Invalid roomId');

	const validated = validatePutBody(event.body);
	if (validated.error || !validated.data) {
		return badRequest(validated.error ?? 'Invalid request body');
	}

	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;
	// The client may choose its own display name for a room; the token's `name` is the
	// fallback when it doesn't. Only the key is taken from the token unconditionally.
	const identity = { ...auth.identity, name: validated.data.name || auth.identity.name };

	// Neither source produced one. Sign-up is open and Clerk does not require a name, so a
	// token with no `name` claim is an ordinary account rather than a broken one — but a
	// nameless participant is a blank row in everyone else's legend, so the write is refused
	// and the client asks for one. 400, not 401: re-authenticating would not supply it.
	if (!identity.name) return badRequest('name is required');

	const now = Date.now();

	// Ensure the user row and its `rooms` map exist before setting a child path — DynamoDB
	// rejects `SET rooms.#rid` when the parent map is absent (a user's very first join). This
	// also refreshes their identity. `email` may be '' for a token with no verified email.
	await ddb.send(
		new UpdateCommand({
			TableName: USERS_TABLE,
			Key: { userId: identity.participantKey },
			UpdateExpression:
				'SET rooms = if_not_exists(rooms, :empty), #name = :name, email = :email, lastActive = :now',
			ExpressionAttributeNames: { '#name': 'name' },
			ExpressionAttributeValues: {
				':empty': {},
				':name': identity.name,
				':email': identity.email,
				':now': now
			}
		})
	);

	// The selections row and the user's room entry go together, so they cannot drift.
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
					Update: {
						TableName: USERS_TABLE,
						Key: { userId: identity.participantKey },
						UpdateExpression: 'SET rooms.#rid = :room',
						ExpressionAttributeNames: { '#rid': roomId },
						ExpressionAttributeValues: {
							':room': { color: validated.data.color, updatedAt: now, name: identity.name }
						}
					}
				}
			]
		})
	);

	return ok({ ok: true, participantKey: identity.participantKey, name: identity.name });
}

async function listMyRooms(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;
	const { identity } = auth;

	// The client hits this on every login (landing-page bootstrap), so it's where a user
	// first becomes visible to the admin panel — which scans this table. Upsert the row so
	// merely signing in counts, even before joining any room: empty `rooms`, notifications
	// off. Every field except identity/lastActive is if_not_exists, so a returning user's
	// rooms, name choice and notification prefs are never clobbered. ALL_NEW hands back the
	// merged row, so we still get their rooms map without a second read.
	const now = Date.now();
	const result = await ddb.send(
		new UpdateCommand({
			TableName: USERS_TABLE,
			Key: { userId: identity.participantKey },
			UpdateExpression:
				'SET rooms = if_not_exists(rooms, :empty), #name = :name, email = :email, ' +
				'lastActive = :now, enabled = if_not_exists(enabled, :false), ' +
				'leadMinutes = if_not_exists(leadMinutes, :lead), ' +
				'notifyMaybe = if_not_exists(notifyMaybe, :maybe), ' +
				'notifyOverrides = if_not_exists(notifyOverrides, :empty)',
			ExpressionAttributeNames: { '#name': 'name' },
			ExpressionAttributeValues: {
				':empty': {},
				':name': identity.name,
				':email': identity.email,
				':now': now,
				':false': false,
				':lead': DEFAULT_NOTIFICATION_SETTINGS.leadMinutes,
				':maybe': DEFAULT_NOTIFICATION_SETTINGS.notifyMaybe
			},
			ReturnValues: 'ALL_NEW'
		})
	);
	const roomsMap = (result.Attributes?.rooms ?? {}) as Record<string, RoomEntry>;

	const rooms = Object.entries(roomsMap).map(([roomId, meta]) => ({
		roomId,
		name: toStr(meta?.name),
		color: toStr(meta?.color),
		updatedAt: toNumber(meta?.updatedAt)
	}));
	rooms.sort((a, b) => b.updatedAt - a.updatedAt);
	return ok(rooms);
}

async function leaveRoom(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const roomId = readRoomId(event);
	if (!roomId) return badRequest('Invalid roomId');

	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;
	const { identity } = auth;

	await ddb.send(
		new TransactWriteCommand({
			TransactItems: [
				{ Delete: { TableName: TABLE, Key: { roomId, userId: identity.participantKey } } },
				{
					// REMOVE of an absent nested path is a no-op, so this is safe even if the user
					// row or the entry is already gone.
					Update: {
						TableName: USERS_TABLE,
						Key: { userId: identity.participantKey },
						UpdateExpression: 'REMOVE rooms.#rid',
						ExpressionAttributeNames: { '#rid': roomId }
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
 * This is the one `/admin/*` route with no `authorization_scopes` on it: gating it on the
 * `admin` scope would make it unable to tell a non-admin so. It decides presentation only
 * — the bundle is static and can be edited by anyone, and the gateway is what actually
 * enforces every other admin route.
 */
function getAdminStatus(event: StagehopperEvent): APIGatewayProxyResultV2 {
	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;

	// 403, not 401: the token is fine, so re-authenticating would only loop.
	if (!hasAdminScope(auth.identity)) return forbidden({ isAdmin: false, error: 'Not an admin' });

	return ok({ isAdmin: true });
}

// ---- Admin: festivals ----

/**
 * The slim, public manifest's key in {@link SITE_BUCKET}; also its public CloudFront path.
 * Landing-card fields only (see {@link publishFestivalsManifest}) — the full record with
 * `description` lives in {@link FESTIVALS_TABLE} and the admin-only `GET /admin/festivals`.
 */
const FESTIVALS_MANIFEST_S3_KEY = 'data/festivals/index.json';

const FESTIVAL_ID_REGEX = /^[a-z0-9]{2,10}$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

interface FestivalRecord {
	id: string;
	name: string;
	location: string;
	startDate: string;
	endDate: string;
	timezone: string;
	imageUrl?: string;
	mapUrl?: string;
	description?: string;
	/** Stage name → `#rrggbb` colour, applied to that stage's timetable cards/header. */
	stageColors?: Record<string, string>;
	/**
	 * Admin-set stage display order, front to back. Stages the timetable knows about but
	 * this list doesn't mention render after it, in first-appearance order — see
	 * `resolveStageOrder` in the app's `timetable.ts`.
	 */
	stageOrder?: string[];
}

/** The landing-card fields republished to {@link FESTIVALS_MANIFEST_S3_KEY} on every write. */
type FestivalManifestEntry = Pick<
	FestivalRecord,
	| 'id'
	| 'name'
	| 'location'
	| 'startDate'
	| 'endDate'
	| 'timezone'
	| 'imageUrl'
	| 'stageColors'
	| 'stageOrder'
>;

const MAX_FESTIVAL_DESCRIPTION_LENGTH = 1000;

/**
 * Whether a string is an IANA timezone the runtime recognizes. `Intl.DateTimeFormat`
 * throws `RangeError` on an unknown zone, so a successful construction is the check —
 * cheaper and more future-proof than diffing against `Intl.supportedValuesOf`.
 */
export function isValidTimeZone(tz: string): boolean {
	if (!tz) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/**
 * Every non-empty string field is trimmed-non-empty, not merely present: an admin
 * pasting a blank name would otherwise silently break the landing page for
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
	// Required on write: the notifier converts wall-clock set times to UTC using this zone.
	// Legacy records lacking it are tolerated on read (defaulted to Europe/Berlin there), but
	// any save must carry a valid IANA zone so the stored data can never be ambiguous.
	if (typeof r.timezone !== 'string' || !isValidTimeZone(r.timezone)) {
		return 'timezone must be a valid IANA timezone';
	}
	if (r.imageUrl !== undefined && typeof r.imageUrl !== 'string') return 'imageUrl must be a string';
	if (r.mapUrl !== undefined && typeof r.mapUrl !== 'string') return 'mapUrl must be a string';
	if (r.description !== undefined) {
		if (typeof r.description !== 'string') return 'description must be a string';
		if (r.description.length > MAX_FESTIVAL_DESCRIPTION_LENGTH) {
			return `description must be at most ${MAX_FESTIVAL_DESCRIPTION_LENGTH} characters`;
		}
	}
	if (r.stageColors !== undefined) {
		if (typeof r.stageColors !== 'object' || r.stageColors === null || Array.isArray(r.stageColors)) {
			return 'stageColors must be an object';
		}
		for (const [stage, color] of Object.entries(r.stageColors as Record<string, unknown>)) {
			if (stage.trim().length === 0) return 'stageColors keys must not be empty';
			if (typeof color !== 'string' || !HEX_COLOR_REGEX.test(color)) {
				return `stageColors["${stage}"] must be a #rrggbb colour`;
			}
		}
	}
	if (r.stageOrder !== undefined) {
		const stageOrderError = validateStageOrder(r.stageOrder);
		if (stageOrderError) return stageOrderError;
	}
	return null;
}

/** Shared by {@link validateFestivalRecord} and the dedicated stage-order patch endpoint. */
function validateStageOrder(value: unknown): string | null {
	if (!Array.isArray(value)) return 'stageOrder must be an array';
	if (value.some((name) => typeof name !== 'string' || name.trim().length === 0)) {
		return 'stageOrder must be an array of non-empty strings';
	}
	return null;
}

/**
 * Publish JSON to a public S3/CloudFront path and invalidate it — the pattern every
 * derived public artifact (the festivals manifest, each festival's timetable) republishes
 * through after a DynamoDB write. Best-effort on the invalidation: a missed one just means
 * the edge catches up on its own TTL by the time `CacheControl: no-cache` next revalidates,
 * not worth failing an otherwise-successful write over.
 */
async function publishJsonToS3(key: string, body: unknown): Promise<void> {
	await s3.send(
		new PutObjectCommand({
			Bucket: SITE_BUCKET,
			Key: key,
			Body: JSON.stringify(body),
			ContentType: 'application/json',
			CacheControl: 'no-cache'
		})
	);

	if (CF_DISTRIBUTION_ID) {
		try {
			await cloudfront.send(
				new CreateInvalidationCommand({
					DistributionId: CF_DISTRIBUTION_ID,
					InvalidationBatch: {
						CallerReference: `${key}-${Date.now()}`,
						Paths: { Quantity: 1, Items: [`/${key}`] }
					}
				})
			);
		} catch (err) {
			console.error(`Published ${key}, but the CloudFront invalidation failed:`, err);
		}
	}
}

/** Delete a published S3 artifact and invalidate its path — the inverse of {@link publishJsonToS3}. */
async function unpublishFromS3(key: string): Promise<void> {
	await s3.send(new DeleteObjectCommand({ Bucket: SITE_BUCKET, Key: key }));
	if (CF_DISTRIBUTION_ID) {
		try {
			await cloudfront.send(
				new CreateInvalidationCommand({
					DistributionId: CF_DISTRIBUTION_ID,
					InvalidationBatch: {
						CallerReference: `${key}-delete-${Date.now()}`,
						Paths: { Quantity: 1, Items: [`/${key}`] }
					}
				})
			);
		} catch (err) {
			console.error(`Deleted ${key}, but the CloudFront invalidation failed:`, err);
		}
	}
}

/**
 * Rebuild and republish the public manifest from every row in {@link FESTIVALS_TABLE}.
 * Called after any festival create/update/delete. An unpaginated `Scan` is fine here —
 * unlike the users table this scans dozens of festivals at most, never thousands.
 */
async function publishFestivalsManifest(): Promise<void> {
	const result = await ddb.send(new ScanCommand({ TableName: FESTIVALS_TABLE }));
	const manifest: FestivalManifestEntry[] = (result.Items ?? []).map((item) => ({
		id: toStr(item.id),
		name: toStr(item.name),
		location: toStr(item.location),
		startDate: toStr(item.startDate),
		endDate: toStr(item.endDate),
		timezone: toStr(item.timezone),
		...(typeof item.imageUrl === 'string' && { imageUrl: item.imageUrl }),
		...(item.stageColors &&
			typeof item.stageColors === 'object' && {
				stageColors: item.stageColors as Record<string, string>
			}),
		...(Array.isArray(item.stageOrder) && { stageOrder: item.stageOrder as string[] })
	}));
	await publishJsonToS3(FESTIVALS_MANIFEST_S3_KEY, manifest);
}

/**
 * The full festival list, read through the API — admin only. `GET /data/festivals/index.json`
 * off CloudFront is the public, landing-card-only equivalent; this returns every field
 * (including `description`) straight from {@link FESTIVALS_TABLE}, so the editor never
 * renders a stale or truncated edge copy of a record it's about to overwrite.
 */
async function getAdminFestivals(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;

	try {
		const result = await ddb.send(new ScanCommand({ TableName: FESTIVALS_TABLE }));
		return ok({ festivals: (result.Items ?? []) as FestivalRecord[] });
	} catch (err) {
		console.error('Failed to scan festivals:', err);
		return serverError();
	}
}

/** Create a new festival. `id` is admin-chosen and write-once (see {@link FestivalRecord}). */
async function createFestival(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;

	const { parsed, error: parseError } = parseJsonBody(event.body);
	if (parseError) return badRequest(parseError);

	const recordError = validateFestivalRecord(parsed);
	if (recordError) return badRequest(recordError);
	const record = parsed as FestivalRecord;

	try {
		await ddb.send(
			new PutCommand({
				TableName: FESTIVALS_TABLE,
				Item: record,
				ConditionExpression: 'attribute_not_exists(id)'
			})
		);
	} catch (err) {
		if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
			return jsonResponse(409, { error: 'A festival with that id already exists' });
		}
		console.error('Failed to create festival:', err);
		return serverError();
	}

	let published = true;
	try {
		await publishFestivalsManifest();
	} catch (err) {
		published = false;
		console.error('Festival created, but publishing the manifest failed:', err);
	}
	return created({ ok: true, festival: record, published });
}

/** Update an existing festival. `id` comes from the path and is immutable, not the body. */
async function updateFestival(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const festivalId = event.pathParameters?.id;
	if (!festivalId || !FESTIVAL_ID_REGEX.test(festivalId)) return badRequest('Invalid festival id');

	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;

	const { parsed, error: parseError } = parseJsonBody(event.body);
	if (parseError) return badRequest(parseError);

	const record = { ...(parsed as Record<string, unknown> | null), id: festivalId };
	const recordError = validateFestivalRecord(record);
	if (recordError) return badRequest(recordError);

	try {
		await ddb.send(
			new PutCommand({
				TableName: FESTIVALS_TABLE,
				Item: record,
				ConditionExpression: 'attribute_exists(id)'
			})
		);
	} catch (err) {
		if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
			return notFound();
		}
		console.error('Failed to update festival:', err);
		return serverError();
	}

	let published = true;
	try {
		await publishFestivalsManifest();
	} catch (err) {
		published = false;
		console.error('Festival updated, but publishing the manifest failed:', err);
	}
	return ok({ ok: true, festival: record as FestivalRecord, published });
}

/**
 * Update a festival's manual stage display order. A dedicated endpoint rather than routing
 * through {@link updateFestival}: the drag-to-reorder UI saves on every drop, and resending
 * (and risking dropping) the entire record — `name`, `mapUrl`, `description`, etc. — on every
 * drag would make that unsafe. This only ever touches the `stageOrder` attribute.
 */
async function updateFestivalStageOrder(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const festivalId = event.pathParameters?.id;
	if (!festivalId || !FESTIVAL_ID_REGEX.test(festivalId)) return badRequest('Invalid festival id');

	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;

	const { parsed, error: parseError } = parseJsonBody(event.body);
	if (parseError) return badRequest(parseError);

	const body = parsed as Record<string, unknown> | null;
	const stageOrderError = validateStageOrder(body?.stageOrder);
	if (stageOrderError) return badRequest(stageOrderError);
	const stageOrder = body!.stageOrder as string[];

	try {
		await ddb.send(
			new UpdateCommand({
				TableName: FESTIVALS_TABLE,
				Key: { id: festivalId },
				ConditionExpression: 'attribute_exists(id)',
				UpdateExpression: 'SET stageOrder = :stageOrder',
				ExpressionAttributeValues: { ':stageOrder': stageOrder }
			})
		);
	} catch (err) {
		if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
			return notFound();
		}
		console.error('Failed to update festival stage order:', err);
		return serverError();
	}

	let published = true;
	try {
		await publishFestivalsManifest();
	} catch (err) {
		published = false;
		console.error('Festival stage order updated, but publishing the manifest failed:', err);
	}
	return ok({ ok: true, stageOrder, published });
}

/**
 * Delete a festival: its row, every performance on its timetable, and both derived public
 * artifacts. Room selections keyed by this festival's performance ids are left alone — same
 * "not cleaned up" tradeoff the per-performance delete already makes (see the timetable
 * editor's delete-confirmation copy).
 */
async function deleteFestival(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const festivalId = event.pathParameters?.id;
	if (!festivalId || !FESTIVAL_ID_REGEX.test(festivalId)) return badRequest('Invalid festival id');

	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;

	try {
		await ddb.send(new DeleteCommand({ TableName: FESTIVALS_TABLE, Key: { id: festivalId } }));

		const performances = await queryAllKeys(PERFORMANCES_TABLE, 'festivalId', festivalId, 'id');
		const performanceIds = performances
			.map((item) => (item as { id?: string }).id)
			.filter((id): id is string => !!id);
		await batchDelete(
			performanceIds.map((id) => ({ table: PERFORMANCES_TABLE as string, key: { festivalId, id } }))
		);
	} catch (err) {
		console.error('Failed to delete festival:', err);
		return serverError();
	}

	// The delete itself already succeeded above — a failure publishing either derived
	// artifact from here on is reported to the caller, not turned into a 500 that would
	// wrongly suggest the festival is still there.
	let published = true;
	try {
		await publishFestivalsManifest();
	} catch (err) {
		published = false;
		console.error('Festival deleted, but republishing the manifest failed:', err);
	}
	try {
		await unpublishFromS3(timetableS3Key(festivalId));
	} catch (err) {
		published = false;
		console.error('Festival deleted, but removing its published timetable failed:', err);
	}

	return ok({ ok: true, published });
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
	event: StagehopperEvent
): Promise<APIGatewayProxyResultV2> {
	const festivalId = event.pathParameters?.id;
	if (!festivalId || !FESTIVAL_ID_REGEX.test(festivalId)) return badRequest('Invalid festival id');

	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;

	const { parsed, error: parseError } = parseJsonBody(event.body);
	if (parseError) return badRequest(parseError);

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

/**
 * Presign a direct-to-S3 upload for a festival's map image.
 * Mirrors presignFestivalImageUpload but uses the `data/festival-maps/` key prefix.
 */
async function presignFestivalMapUpload(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const festivalId = event.pathParameters?.id;
	if (!festivalId || !FESTIVAL_ID_REGEX.test(festivalId)) return badRequest('Invalid festival id');

	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;

	const { parsed, error: parseError } = parseJsonBody(event.body);
	if (parseError) return badRequest(parseError);

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

	const extension = ALLOWED_IMAGE_CONTENT_TYPES[contentType];
	const key = `data/festival-maps/${festivalId}-${randomBytes(8).toString('hex')}.${extension}`;

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
		console.error('Failed to presign a festival map upload:', err);
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
	spotify?: unknown;
	youtube?: unknown;
	soundcloud?: unknown;
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

interface TimetableUploadPerformance {
	artist: string;
	stage: string;
	startTime: string;
	endTime: string;
	artists?: unknown;
	artistImage?: unknown;
	instagram?: unknown;
	spotify?: unknown;
	youtube?: unknown;
	soundcloud?: unknown;
}

interface TimetableUploadDay {
	date: string;
	performances: TimetableUploadPerformance[];
}

interface TimetableUploadPayload {
	formatVersion: 1;
	festivalId: string;
	days: TimetableUploadDay[];
}

/**
 * Validate an uploaded timetable file — the canonical v1 shape minus `id`: an uploaded
 * file is never responsible for supplying unique performance ids, since the importer
 * assigns its own regardless of what (if anything) the file includes. Mirrors the
 * client's `validateTimetableImport` (there's no shared module — separate projects); the
 * client is untrusted, so this is the rule, not the hint.
 */
export function validateTimetableUploadPayload(raw: unknown): {
	data?: TimetableUploadPayload;
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

	return { data: obj as unknown as TimetableUploadPayload };
}

/**
 * Assign every performance a fresh id — random hex, matching the room id pattern
 * (`generateRoomId` in rooms.ts) — regardless of anything the upload supplied. Ids only
 * need to be unique within this one festival's timetable, not globally.
 */
function assignPerformanceIds(upload: TimetableUploadPayload): TimetableImportPayload {
	const seen = new Set<string>();
	const nextId = (): string => {
		let candidate = randomBytes(3).toString('hex');
		while (seen.has(candidate)) candidate = randomBytes(3).toString('hex');
		seen.add(candidate);
		return candidate;
	};

	return {
		formatVersion: 1,
		festivalId: upload.festivalId,
		days: upload.days.map((day) => ({
			date: day.date,
			// `id` spread last: an id the raw upload happens to carry (its type says it
			// shouldn't, but nothing strips it from the actual parsed JSON) must not win
			// over the generated one — the whole point is the importer decides ids, not
			// the file.
			performances: day.performances.map((perf) => ({ ...perf, id: nextId() }))
		}))
	};
}

function timetableS3Key(festivalId: string): string {
	return `data/festivals/${festivalId}/timetable.json`;
}

/** One performance as stored in {@link PERFORMANCES_TABLE} (PK `festivalId`, SK `id`). */
interface PerformanceItem {
	festivalId: string;
	id: string;
	date: string;
	artist: string;
	stage: string;
	startTime: string;
	endTime: string;
	artistImage?: string;
	instagram?: string;
	spotify?: string;
	youtube?: string;
	soundcloud?: string;
	/** Per-artist lineup enrichment (bio, genres, socials) from the import feed; not admin-editable. */
	artists?: unknown;
}

/** Every performance row for one festival, following the Query cursor to the end. */
async function fetchFestivalPerformances(festivalId: string): Promise<PerformanceItem[]> {
	const items: PerformanceItem[] = [];
	let startKey: Record<string, unknown> | undefined;
	do {
		const result = await ddb.send(
			new QueryCommand({
				TableName: PERFORMANCES_TABLE,
				KeyConditionExpression: 'festivalId = :fid',
				ExpressionAttributeValues: { ':fid': festivalId },
				ExclusiveStartKey: startKey
			})
		);
		items.push(...((result.Items ?? []) as PerformanceItem[]));
		startKey = result.LastEvaluatedKey;
	} while (startKey);
	return items;
}

/** Group flat performance rows back into the canonical v1 `days` shape, for publishing. */
function assembleTimetable(festivalId: string, items: PerformanceItem[]): TimetableImportPayload {
	const byDate = new Map<string, TimetableImportPerformance[]>();
	for (const { festivalId: _fid, date, ...perf } of items) {
		if (!byDate.has(date)) byDate.set(date, []);
		byDate.get(date)!.push(perf);
	}

	const days = [...byDate.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, performances]) => ({
			date,
			performances: [...performances].sort((a, b) => a.startTime.localeCompare(b.startTime))
		}));

	return { formatVersion: 1, festivalId, days };
}

/** Rebuild and republish one festival's public timetable file from {@link PERFORMANCES_TABLE}. */
async function publishFestivalTimetable(festivalId: string): Promise<TimetableImportPayload> {
	const items = await fetchFestivalPerformances(festivalId);
	const timetable = assembleTimetable(festivalId, items);
	await publishJsonToS3(timetableS3Key(festivalId), timetable);
	return timetable;
}

/**
 * Import a festival's timetable — write-once, at festival creation only. No re-import,
 * no diffing, no merge: selections are keyed by performance id, and a re-keyed feed
 * would silently orphan every existing pick with no error. Post-creation changes are
 * per-card edits, not a second import.
 */
async function importFestivalTimetable(
	event: StagehopperEvent
): Promise<APIGatewayProxyResultV2> {
	const festivalId = event.pathParameters?.id;
	if (!festivalId || !FESTIVAL_ID_REGEX.test(festivalId)) return badRequest('Invalid festival id');

	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;

	const { parsed, error: parseError } = parseJsonBody(event.body);
	if (parseError) return badRequest(parseError);

	const validated = validateTimetableUploadPayload(
		(parsed as { timetable?: unknown } | null)?.timetable
	);
	if (validated.error || !validated.data) return badRequest(validated.error ?? 'Invalid timetable');
	if (validated.data.festivalId !== festivalId) {
		return badRequest('festivalId in the file does not match the festival being imported into');
	}

	try {
		const existing = await ddb.send(
			new QueryCommand({
				TableName: PERFORMANCES_TABLE,
				KeyConditionExpression: 'festivalId = :fid',
				ExpressionAttributeValues: { ':fid': festivalId },
				Limit: 1
			})
		);
		if ((existing.Items ?? []).length > 0) {
			return jsonResponse(409, { error: 'A timetable already exists for this festival' });
		}
	} catch (err) {
		console.error('Failed to check for an existing timetable:', err);
		return serverError();
	}

	const withIds = assignPerformanceIds(validated.data);
	const items: Record<string, unknown>[] = withIds.days.flatMap((day) =>
		day.performances.map((perf) => ({ festivalId, date: day.date, ...perf }))
	);

	try {
		await batchPut(PERFORMANCES_TABLE as string, items);
	} catch (err) {
		console.error('Failed to write timetable performances:', err);
		return serverError();
	}

	let published = true;
	try {
		await publishFestivalTimetable(festivalId);
	} catch (err) {
		published = false;
		console.error('Timetable saved, but publishing it failed:', err);
	}

	return ok({ ok: true, published });
}

// ---- Admin: per-performance timetable editing ----

const EDITABLE_PERFORMANCE_FIELDS = new Set([
	'artist',
	'stage',
	'startTime',
	'endTime',
	'artistImage',
	'instagram',
	'spotify',
	'youtube',
	'soundcloud'
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
	if ('spotify' in patch && typeof patch.spotify !== 'string') {
		return 'spotify must be a string';
	}
	if ('youtube' in patch && typeof patch.youtube !== 'string') {
		return 'youtube must be a string';
	}
	if ('soundcloud' in patch && typeof patch.soundcloud !== 'string') {
		return 'soundcloud must be a string';
	}
	return null;
}

function buildPerformanceItem(
	festivalId: string,
	id: string,
	date: string,
	patch: Record<string, unknown>
): PerformanceItem {
	return {
		festivalId,
		id,
		date,
		artist: patch.artist as string,
		stage: patch.stage as string,
		startTime: patch.startTime as string,
		endTime: patch.endTime as string,
		...(typeof patch.artistImage === 'string' && { artistImage: patch.artistImage }),
		...(typeof patch.instagram === 'string' && { instagram: patch.instagram }),
		...(typeof patch.spotify === 'string' && { spotify: patch.spotify }),
		...(typeof patch.youtube === 'string' && { youtube: patch.youtube }),
		...(typeof patch.soundcloud === 'string' && { soundcloud: patch.soundcloud })
	};
}

/**
 * Edit, add or delete one performance — a single DynamoDB item write, then a republish of
 * the festival's public timetable file. Concurrent edits to *different* performances no
 * longer interact at all, which is the whole point of moving off one S3 blob; two edits to
 * the *same* performance are last-write-wins, with no 412 — a much smaller blast radius
 * than the old whole-file conflict, not worth reintroducing optimistic-concurrency for.
 */
async function patchFestivalTimetable(
	event: StagehopperEvent
): Promise<APIGatewayProxyResultV2> {
	const festivalId = event.pathParameters?.id;
	if (!festivalId || !FESTIVAL_ID_REGEX.test(festivalId)) return badRequest('Invalid festival id');

	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;

	const { parsed, error: parseError } = parseJsonBody(event.body);
	if (parseError) return badRequest(parseError);

	const body = parsed as { performanceId?: unknown; patch?: unknown } | null;
	if (typeof body?.performanceId !== 'string' || body.performanceId.trim().length === 0) {
		return badRequest('performanceId is required');
	}
	if (!body || !('patch' in body)) {
		return badRequest('patch is required (null to delete a performance)');
	}
	const { performanceId, patch } = body;

	try {
		if (patch === null) {
			const existing = await ddb.send(
				new GetCommand({ TableName: PERFORMANCES_TABLE, Key: { festivalId, id: performanceId } })
			);
			if (!existing.Item) return badRequest(`no performance with id: ${performanceId}`);
			await ddb.send(
				new DeleteCommand({ TableName: PERFORMANCES_TABLE, Key: { festivalId, id: performanceId } })
			);
		} else {
			if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
				return badRequest('patch must be an object, or null to delete');
			}
			const patchObj = patch as Record<string, unknown>;

			const existing = await ddb.send(
				new GetCommand({ TableName: PERFORMANCES_TABLE, Key: { festivalId, id: performanceId } })
			);

			if (!existing.Item) {
				const fieldError = validatePatchFields(
					patchObj,
					new Set([...EDITABLE_PERFORMANCE_FIELDS, 'date'])
				);
				if (fieldError) return badRequest(fieldError);
				for (const field of REQUIRED_ON_ADD) {
					if (typeof patchObj[field] !== 'string') return badRequest(`${field} is required`);
				}
				if (typeof patchObj.date !== 'string' || !ISO_DATE_REGEX.test(patchObj.date)) {
					return badRequest('date must be an ISO date (YYYY-MM-DD) when adding a performance');
				}

				await ddb.send(
					new PutCommand({
						TableName: PERFORMANCES_TABLE,
						Item: buildPerformanceItem(festivalId, performanceId, patchObj.date, patchObj)
					})
				);
			} else {
				if (Object.keys(patchObj).length === 0) return badRequest('patch must include at least one field');
				const fieldError = validatePatchFields(patchObj, EDITABLE_PERFORMANCE_FIELDS);
				if (fieldError) return badRequest(fieldError);

				const setClauses: string[] = [];
				const names: Record<string, string> = {};
				const values: Record<string, unknown> = {};
				let i = 0;
				for (const [field, value] of Object.entries(patchObj)) {
					const nameKey = `#f${i}`;
					const valueKey = `:f${i}`;
					names[nameKey] = field;
					values[valueKey] = value;
					setClauses.push(`${nameKey} = ${valueKey}`);
					i++;
				}
				await ddb.send(
					new UpdateCommand({
						TableName: PERFORMANCES_TABLE,
						Key: { festivalId, id: performanceId },
						UpdateExpression: `SET ${setClauses.join(', ')}`,
						ExpressionAttributeNames: names,
						ExpressionAttributeValues: values
					})
				);
			}
		}
	} catch (err) {
		console.error('Failed to write the patched performance:', err);
		return serverError();
	}

	let timetable: TimetableImportPayload;
	let published = true;
	try {
		timetable = await publishFestivalTimetable(festivalId);
	} catch (err) {
		published = false;
		console.error('Performance saved, but publishing the timetable failed:', err);
		timetable = assembleTimetable(festivalId, await fetchFestivalPerformances(festivalId));
	}

	return ok({ ok: true, timetable, published });
}

// ---- Admin: browse and delete rooms and users ----

/**
 * Hard cap on user rows scanned per request. The client pages with the returned cursor;
 * each user is a single row, so no cross-page merge is needed — this only bounds one
 * invocation's work, never the result.
 */
const ADMIN_SCAN_PAGE_SIZE = 200;

/** DynamoDB's own hard limit on items in a single BatchWriteItem request, across all tables. */
const BATCH_WRITE_CHUNK = 25;

/** A user id is always `clerk:<sub>`; only the shape is checked, never the live account. */
const USER_ID_REGEX = /^clerk:[^\s/]{1,128}$/;

/** One room on a user's `rooms` map: the per-room bits `listMyRooms` and the admin need. */
interface RoomEntry {
	color?: unknown;
	updatedAt?: unknown;
	name?: unknown;
}

/** A row in the users table (PK userId): identity, the `rooms` map, and notification settings. */
interface UserRow {
	userId?: string;
	name?: unknown;
	email?: unknown;
	lastActive?: unknown;
	rooms?: Record<string, RoomEntry>;
}

/** The opaque continuation cursor a prior page returned, echoed back in the next request body. */
function readStartKey(parsed: unknown): Record<string, unknown> | undefined {
	const startKey = (parsed as { startKey?: unknown } | null)?.startKey;
	if (startKey && typeof startKey === 'object' && !Array.isArray(startKey)) {
		return startKey as Record<string, unknown>;
	}
	return undefined;
}

/** Scan one bounded page of the users table — the only global index the schema affords. */
async function scanUsersPage(
	startKey?: Record<string, unknown>
): Promise<{ rows: UserRow[]; nextKey?: Record<string, unknown> }> {
	const result = await ddb.send(
		new ScanCommand({
			TableName: USERS_TABLE,
			Limit: ADMIN_SCAN_PAGE_SIZE,
			ExclusiveStartKey: startKey
		})
	);
	return { rows: (result.Items ?? []) as UserRow[], nextKey: result.LastEvaluatedKey };
}

/**
 * The page cursor a prior admin listing returned, or undefined for the first page.
 *
 * The body is now optional — it carried the token before, and carries nothing but this
 * cursor since — so an absent or unparseable one means "first page" rather than an error.
 */
function readAdminStartKey(event: StagehopperEvent): Record<string, unknown> | undefined {
	const { parsed } = parseJsonBody(event.body);
	return readStartKey(parsed);
}

function toNumber(value: unknown): number {
	return typeof value === 'number' ? value : 0;
}

function toStr(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/**
 * List rooms — one scanned page of users, aggregated by room from each user's `rooms` map.
 * `participantCount` is how many users list the room; `updatedAt` is the newest across them.
 * The client merges these partial aggregates as it pages, so a room whose participants span
 * pages still sums.
 */
async function listAdminRooms(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const { rows, nextKey } = await scanUsersPage(readAdminStartKey(event));

	const byRoom = new Map<string, { roomId: string; participantCount: number; updatedAt: number }>();
	for (const row of rows) {
		for (const [roomId, meta] of Object.entries(row.rooms ?? {})) {
			const updatedAt = toNumber(meta?.updatedAt);
			const existing = byRoom.get(roomId);
			if (existing) {
				existing.participantCount += 1;
				existing.updatedAt = Math.max(existing.updatedAt, updatedAt);
			} else {
				byRoom.set(roomId, { roomId, participantCount: 1, updatedAt });
			}
		}
	}

	return ok({ rooms: [...byRoom.values()], nextKey: nextKey ?? null });
}

/**
 * List users — one scanned page, one entry per user row. `roomCount` is the size of their
 * `rooms` map. Every signed-in user has a row (a save or a push subscription creates it), so
 * a user who has joined no room still appears here, with `roomCount` 0.
 */
async function listAdminUsers(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const { rows, nextKey } = await scanUsersPage(readAdminStartKey(event));

	const users = rows
		.filter((row) => row.userId)
		.map((row) => ({
			userId: row.userId as string,
			name: toStr(row.name),
			email: toStr(row.email),
			roomCount: Object.keys(row.rooms ?? {}).length,
			lastActive: toNumber(row.lastActive)
		}));

	return ok({ users, nextKey: nextKey ?? null });
}

/** Every key in one table, following the Query cursor to the end. */
async function queryAllKeys(
	table: string | undefined,
	keyName: string,
	keyValue: string,
	project: string
): Promise<Record<string, unknown>[]> {
	const items: Record<string, unknown>[] = [];
	let startKey: Record<string, unknown> | undefined;
	do {
		const result = await ddb.send(
			new QueryCommand({
				TableName: table,
				KeyConditionExpression: '#k = :v',
				ExpressionAttributeNames: { '#k': keyName },
				ExpressionAttributeValues: { ':v': keyValue },
				ProjectionExpression: project,
				ExclusiveStartKey: startKey
			})
		);
		items.push(...(result.Items ?? []));
		startKey = result.LastEvaluatedKey;
	} while (startKey);
	return items;
}

/** Attempts per chunk before giving up — the first send plus four retries. */
const BATCH_MAX_ATTEMPTS = 5;
/** Base backoff between retries; doubles each attempt, with jitter, to ease off a throttled table. */
const BATCH_RETRY_BASE_MS = 50;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send one BatchWriteItem request, retrying whatever comes back as `UnprocessedItems` with
 * exponential backoff before giving up — DynamoDB can return some items unprocessed under
 * throttling rather than failing outright, and a half-finished batch would strand rows.
 */
async function runBatchWrite(
	initial: Record<
		string,
		({ PutRequest: { Item: Record<string, unknown> } } | { DeleteRequest: { Key: Record<string, unknown> } })[]
	>
): Promise<void> {
	let pending = initial;
	for (let attempt = 0; attempt < BATCH_MAX_ATTEMPTS && Object.keys(pending).length > 0; attempt++) {
		// Back off only between attempts, never before the first send.
		if (attempt > 0) {
			await delay(BATCH_RETRY_BASE_MS * 2 ** (attempt - 1) * (1 + Math.random()));
		}
		const result = await ddb.send(new BatchWriteCommand({ RequestItems: pending }));
		pending = (result.UnprocessedItems ?? {}) as typeof pending;
	}
	if (Object.keys(pending).length > 0) {
		throw new Error('BatchWrite left items unprocessed after retries');
	}
}

/**
 * Delete every `{ table, key }` in BatchWrite chunks of 25 (the total-items limit spans all
 * tables in a request, so a chunk may mix both). Deleting a key that's already gone is a
 * no-op, so a caller re-running after an exhausted-retry failure is safe.
 */
async function batchDelete(deletes: { table: string; key: Record<string, unknown> }[]): Promise<void> {
	for (let i = 0; i < deletes.length; i += BATCH_WRITE_CHUNK) {
		const chunk = deletes.slice(i, i + BATCH_WRITE_CHUNK);
		const pending: Record<string, { DeleteRequest: { Key: Record<string, unknown> } }[]> = {};
		for (const { table, key } of chunk) {
			(pending[table] ??= []).push({ DeleteRequest: { Key: key } });
		}
		await runBatchWrite(pending);
	}
}

/** Write every item to one table in BatchWrite chunks of 25. */
async function batchPut(table: string, items: Record<string, unknown>[]): Promise<void> {
	for (let i = 0; i < items.length; i += BATCH_WRITE_CHUNK) {
		const chunk = items.slice(i, i + BATCH_WRITE_CHUNK);
		await runBatchWrite({ [table]: chunk.map((Item) => ({ PutRequest: { Item } })) });
	}
}

/**
 * Hard-delete a room: every selection row for it, plus the room's entry on each member's user
 * row. The selections table is keyed (roomId, userId), so a Query by roomId lists exactly the
 * members whose rows must be cleaned. No soft-delete flag — filtering one out would land on the
 * hot `getSelections` path forever to guard against a rare admin misclick (the id-typing UI does).
 *
 * The selection rows are batch-deleted; the per-user `rooms.<roomId>` entries are removed with a
 * `REMOVE` update each (a nested-map delete isn't a BatchWriteItem operation).
 */
async function deleteAdminRoom(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const roomId = event.pathParameters?.roomId;
	if (!roomId || !VALID_ROOM_ID_REGEX.test(roomId)) return badRequest('Invalid roomId');

	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;

	try {
		const members = await queryAllKeys(TABLE, 'roomId', roomId, 'userId');
		const userIds = members
			.map((item) => (item as { userId?: string }).userId)
			.filter((id): id is string => !!id);

		await batchDelete(userIds.map((userId) => ({ table: TABLE as string, key: { roomId, userId } })));
		await Promise.all(userIds.map((userId) => removeRoomFromUser(userId, roomId)));

		console.log(`Admin ${auth.identity.email} hard-deleted room ${roomId} (${userIds.length} participants)`);
		return ok({ ok: true, deleted: userIds.length });
	} catch (err) {
		console.error('Failed to delete room:', err);
		return serverError();
	}
}

/** Drop one room from a user's `rooms` map. A no-op if the entry (or row) is already gone. */
async function removeRoomFromUser(userId: string, roomId: string): Promise<void> {
	await ddb.send(
		new UpdateCommand({
			TableName: USERS_TABLE,
			Key: { userId },
			UpdateExpression: 'REMOVE rooms.#rid',
			ExpressionAttributeNames: { '#rid': roomId }
		})
	);
}

/**
 * Hard-delete a user: their user row (which carries their room list and notification settings),
 * their selection rows across every room, and their push subscriptions. The user row's `rooms`
 * map names every room to clear on the selections table.
 */
async function deleteAdminUser(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const userId = event.pathParameters?.userId;
	if (!userId || !USER_ID_REGEX.test(userId)) return badRequest('Invalid userId');

	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;

	try {
		const userRow = await ddb.send(
			new GetCommand({ TableName: USERS_TABLE, Key: { userId } })
		);
		const roomIds = Object.keys((userRow.Item?.rooms ?? {}) as Record<string, unknown>);
		const subs = await queryAllKeys(PUSH_SUBSCRIPTIONS_TABLE, 'userId', userId, 'endpoint');

		const deletes = [
			{ table: USERS_TABLE as string, key: { userId } },
			...roomIds.map((roomId) => ({ table: TABLE as string, key: { roomId, userId } })),
			...subs.map((s) => ({
				table: PUSH_SUBSCRIPTIONS_TABLE as string,
				key: { userId, endpoint: (s as { endpoint?: string }).endpoint }
			}))
		];
		await batchDelete(deletes);
		console.log(`Admin ${auth.identity.email} hard-deleted user ${userId} (${roomIds.length} rooms)`);
		return ok({ ok: true, deleted: roomIds.length });
	} catch (err) {
		console.error('Failed to delete user:', err);
		return serverError();
	}
}

/**
 * Send a test push to one user, on demand. Invokes the notifier Lambda synchronously with a
 * `{ test, userId }` event so push sending and the VAPID keys stay in a single function; the
 * notifier's per-device counts are relayed back so the admin sees exactly what happened.
 */
async function sendTestNotification(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const userId = event.pathParameters?.userId;
	if (!userId || !USER_ID_REGEX.test(userId)) return badRequest('Invalid userId');

	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;

	try {
		const result = await lambda.send(
			new InvokeCommand({
				FunctionName: NOTIFIER_FUNCTION_NAME,
				// RequestResponse: wait for the send so the admin gets a real result, not a
				// fire-and-forget that always looks successful.
				InvocationType: 'RequestResponse',
				Payload: Buffer.from(JSON.stringify({ test: true, userId }))
			})
		);

		// A function error (thrown inside the notifier) surfaces as FunctionError; the payload
		// then holds the error, not our result shape.
		if (result.FunctionError) {
			console.error(`Test notification: notifier errored for ${userId}:`, decodePayload(result.Payload));
			return serverError();
		}

		const payload = decodePayload(result.Payload) as {
			ok?: boolean;
			sent?: number;
			total?: number;
			error?: string;
		} | null;

		if (!payload?.ok) {
			// No subscriptions, or every send failed — a client-actionable outcome, not a 500.
			return badRequest(payload?.error ?? 'The user has no devices that could be notified');
		}

		console.log(`Admin ${auth.identity.email} sent a test notification to ${userId} (${payload.sent}/${payload.total})`);
		return ok({ ok: true, sent: payload.sent ?? 0, total: payload.total ?? 0 });
	} catch (err) {
		console.error('Failed to send test notification:', err);
		return serverError();
	}
}

/** Decode a Lambda invoke response payload (a Uint8Array of JSON) into an object, or null. */
function decodePayload(payload: Uint8Array | undefined): unknown {
	if (!payload || payload.length === 0) return null;
	try {
		return JSON.parse(Buffer.from(payload).toString('utf8'));
	} catch {
		return null;
	}
}

// ---- Push notifications ----

/** The lead-time presets the popup offers; the server rejects anything else. */
const NOTIFICATION_LEAD_OPTIONS = new Set([5, 10, 15, 20, 30]);

/** Settings as stored/returned; a user with no row yet reads these defaults. */
const DEFAULT_NOTIFICATION_SETTINGS = {
	leadMinutes: 15,
	notifyMaybe: false
};

/**
 * The caller and the parsed body for a notification route. These key on the user, never on
 * their display name, so only the participant key is taken from the token.
 *
 * These four routes keep their bodies (and `POST` for the read) because the body carries a
 * push `endpoint` — a long opaque URL that has no business in a query string.
 */
function resolveNotificationIdentity(
	event: StagehopperEvent
): { userId: string; parsed: unknown } | { error: APIGatewayProxyResultV2 } {
	const auth = requireIdentity(event);
	if ('error' in auth) return auth;

	const { parsed, error: parseError } = parseJsonBody(event.body);
	if (parseError) return { error: badRequest(parseError) };

	return { userId: auth.identity.participantKey, parsed };
}

/**
 * Read the caller's notification settings plus whether *this* device is subscribed.
 * `enabled` is derived from having at least one live subscription, never stored as truth.
 */
async function getNotificationSettings(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const auth = resolveNotificationIdentity(event);
	if ('error' in auth) return auth.error;
	const { userId, parsed } = auth;

	const endpoint = (parsed as { endpoint?: unknown } | null)?.endpoint;
	const thisEndpoint = typeof endpoint === 'string' ? endpoint : '';

	try {
		const settingsResult = await ddb.send(
			new GetCommand({ TableName: USERS_TABLE, Key: { userId } })
		);
		const row = (settingsResult.Item ?? {}) as {
			leadMinutes?: number;
			notifyMaybe?: boolean;
			notifyOverrides?: Record<string, boolean>;
		};

		const subs = await queryAllKeys(PUSH_SUBSCRIPTIONS_TABLE, 'userId', userId, 'endpoint');

		return ok({
			leadMinutes:
				typeof row.leadMinutes === 'number'
					? row.leadMinutes
					: DEFAULT_NOTIFICATION_SETTINGS.leadMinutes,
			notifyMaybe: row.notifyMaybe ?? DEFAULT_NOTIFICATION_SETTINGS.notifyMaybe,
			notifyOverrides: row.notifyOverrides ?? {},
			enabled: subs.length > 0,
			subscribedHere: subs.some((s) => (s as { endpoint?: string }).endpoint === thisEndpoint)
		});
	} catch (err) {
		console.error('Failed to read notification settings:', err);
		return serverError();
	}
}

/**
 * Write the caller's notification preferences: the lead time + "maybe" switch, a patch of
 * per-performance overrides, or both in one call. At least one of `leadMinutes`/`notifyMaybe`
 * (given together) or `notifyOverrides` must be present. Never touches subscriptions or the
 * derived `enabled` flag.
 *
 * `notifyOverrides` is a sparse patch keyed by performance id: `true`/`false` sets an explicit
 * override, `null` removes it (reverting that performance to the default rule). The parent
 * `notifyOverrides` map is seeded at sign-in/subscribe time (see `listMyRooms`/
 * `addPushSubscription`), so a nested per-key SET here can assume it already exists.
 */
async function putNotificationSettings(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const auth = resolveNotificationIdentity(event);
	if ('error' in auth) return auth.error;
	const { userId, parsed } = auth;

	const body = (parsed ?? {}) as {
		leadMinutes?: unknown;
		notifyMaybe?: unknown;
		notifyOverrides?: unknown;
	};

	const hasSettings = body.leadMinutes !== undefined || body.notifyMaybe !== undefined;
	const hasOverrides = body.notifyOverrides !== undefined;
	if (!hasSettings && !hasOverrides) {
		return badRequest('Provide leadMinutes and notifyMaybe, notifyOverrides, or both');
	}

	if (hasSettings) {
		if (typeof body.leadMinutes !== 'number' || !NOTIFICATION_LEAD_OPTIONS.has(body.leadMinutes)) {
			return badRequest('leadMinutes must be one of 5, 10, 15, 20, 30');
		}
		if (typeof body.notifyMaybe !== 'boolean') {
			return badRequest('notifyMaybe must be a boolean');
		}
	}

	const setClauses: string[] = [];
	const removeClauses: string[] = [];
	const names: Record<string, string> = {};
	const values: Record<string, unknown> = {};

	if (hasSettings) {
		setClauses.push('leadMinutes = :lead', 'notifyMaybe = :maybe');
		values[':lead'] = body.leadMinutes;
		values[':maybe'] = body.notifyMaybe;
	}

	if (hasOverrides) {
		const raw = body.notifyOverrides;
		if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
			return badRequest('notifyOverrides must be an object of performanceId -> boolean|null');
		}
		const entries = Object.entries(raw as Record<string, unknown>);
		if (entries.length === 0) {
			return badRequest('notifyOverrides must include at least one performance id');
		}
		let i = 0;
		for (const [perfId, value] of entries) {
			if (typeof value !== 'boolean' && value !== null) {
				return badRequest(`notifyOverrides.${perfId} must be a boolean or null`);
			}
			const nameKey = `#o${i}`;
			names[nameKey] = perfId;
			if (value === null) {
				removeClauses.push(`notifyOverrides.${nameKey}`);
			} else {
				const valueKey = `:o${i}`;
				setClauses.push(`notifyOverrides.${nameKey} = ${valueKey}`);
				values[valueKey] = value;
			}
			i++;
		}
	}

	const expression = [
		setClauses.length > 0 ? `SET ${setClauses.join(', ')}` : '',
		removeClauses.length > 0 ? `REMOVE ${removeClauses.join(', ')}` : ''
	]
		.filter(Boolean)
		.join(' ');

	try {
		await ddb.send(
			new UpdateCommand({
				TableName: USERS_TABLE,
				Key: { userId },
				UpdateExpression: expression,
				...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
				...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {})
			})
		);
		return ok({
			...(hasSettings ? { leadMinutes: body.leadMinutes, notifyMaybe: body.notifyMaybe } : {}),
			ok: true
		});
	} catch (err) {
		console.error('Failed to write notification settings:', err);
		return serverError();
	}
}

/**
 * Register one device's Web Push subscription. Marks the user `enabled` and seeds a
 * default settings row if they have none yet (so the notifier's scan can find them).
 */
async function addPushSubscription(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const auth = resolveNotificationIdentity(event);
	if ('error' in auth) return auth.error;
	const { userId, parsed } = auth;

	const subscription = (parsed as { subscription?: unknown } | null)?.subscription as
		| { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
		| undefined;

	const endpoint = subscription?.endpoint;
	const p256dh = subscription?.keys?.p256dh;
	const authKey = subscription?.keys?.auth;
	if (
		typeof endpoint !== 'string' ||
		endpoint.length === 0 ||
		typeof p256dh !== 'string' ||
		typeof authKey !== 'string'
	) {
		return badRequest('subscription must include endpoint and keys {p256dh, auth}');
	}

	try {
		await ddb.send(
			new PutCommand({
				TableName: PUSH_SUBSCRIPTIONS_TABLE,
				Item: { userId, endpoint, keys: { p256dh, auth: authKey }, createdAt: Date.now() }
			})
		);
		// enabled = true, and default settings if the row is new. if_not_exists keeps the
		// user's chosen lead/toggle/overrides when they re-subscribe another device.
		await ddb.send(
			new UpdateCommand({
				TableName: USERS_TABLE,
				Key: { userId },
				UpdateExpression:
					'SET enabled = :true, leadMinutes = if_not_exists(leadMinutes, :lead), ' +
					'notifyMaybe = if_not_exists(notifyMaybe, :maybe), ' +
					'notifyOverrides = if_not_exists(notifyOverrides, :empty)',
				ExpressionAttributeValues: {
					':true': true,
					':lead': DEFAULT_NOTIFICATION_SETTINGS.leadMinutes,
					':maybe': DEFAULT_NOTIFICATION_SETTINGS.notifyMaybe,
					':empty': {}
				}
			})
		);
		return ok({ ok: true });
	} catch (err) {
		console.error('Failed to add push subscription:', err);
		return serverError();
	}
}

/**
 * Remove one device's subscription (deactivate on this device only). When the user has
 * no subscriptions left, flip `enabled` false so the notifier skips them.
 */
async function removePushSubscription(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const auth = resolveNotificationIdentity(event);
	if ('error' in auth) return auth.error;
	const { userId, parsed } = auth;

	const endpoint = (parsed as { endpoint?: unknown } | null)?.endpoint;
	if (typeof endpoint !== 'string' || endpoint.length === 0) {
		return badRequest('endpoint is required');
	}

	try {
		await ddb.send(
			new DeleteCommand({ TableName: PUSH_SUBSCRIPTIONS_TABLE, Key: { userId, endpoint } })
		);
		const remaining = await queryAllKeys(PUSH_SUBSCRIPTIONS_TABLE, 'userId', userId, 'endpoint');
		if (remaining.length === 0) {
			await ddb.send(
				new UpdateCommand({
					TableName: USERS_TABLE,
					Key: { userId },
					UpdateExpression: 'SET enabled = :false',
					ExpressionAttributeValues: { ':false': false }
				})
			);
		}
		return ok({ ok: true });
	} catch (err) {
		console.error('Failed to remove push subscription:', err);
		return serverError();
	}
}

/**
 * Registering a room id is a no-op write: rooms materialize when their first
 * selection is saved, so this only validates and echoes the id back.
 */
function registerRoom(event: StagehopperEvent): APIGatewayProxyResultV2 {
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

export const handler = async (event: StagehopperEvent): Promise<APIGatewayProxyResultV2> => {
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
			case 'GET /api/stagehopper/users/me/rooms':
				return await listMyRooms(event);
			case 'POST /api/stagehopper/users/me/notifications':
				return await getNotificationSettings(event);
			case 'PUT /api/stagehopper/users/me/notifications':
				return await putNotificationSettings(event);
			case 'POST /api/stagehopper/users/me/notifications/subscription':
				return await addPushSubscription(event);
			case 'DELETE /api/stagehopper/users/me/notifications/subscription':
				return await removePushSubscription(event);
			case 'GET /api/stagehopper/admin/me':
				return getAdminStatus(event);
			case 'GET /api/stagehopper/admin/festivals':
				return await getAdminFestivals(event);
			case 'POST /api/stagehopper/admin/festivals':
				return await createFestival(event);
			case 'PATCH /api/stagehopper/admin/festivals/{id}':
				return await updateFestival(event);
			case 'PATCH /api/stagehopper/admin/festivals/{id}/stage-order':
				return await updateFestivalStageOrder(event);
			case 'DELETE /api/stagehopper/admin/festivals/{id}':
				return await deleteFestival(event);
			case 'POST /api/stagehopper/admin/festivals/{id}/image-upload':
				return await presignFestivalImageUpload(event);
			case 'POST /api/stagehopper/admin/festivals/{id}/map-upload':
				return await presignFestivalMapUpload(event);
			case 'POST /api/stagehopper/admin/festivals/{id}/timetable-import':
				return await importFestivalTimetable(event);
			case 'PATCH /api/stagehopper/admin/festivals/{id}/timetable':
				return await patchFestivalTimetable(event);
			case 'POST /api/stagehopper/admin/rooms':
				return await listAdminRooms(event);
			case 'POST /api/stagehopper/admin/users':
				return await listAdminUsers(event);
			case 'DELETE /api/stagehopper/admin/rooms/{roomId}':
				return await deleteAdminRoom(event);
			case 'DELETE /api/stagehopper/admin/users/{userId}':
				return await deleteAdminUser(event);
			case 'POST /api/stagehopper/admin/users/{userId}/test-notification':
				return await sendTestNotification(event);
			default:
				return notFound();
		}
	} catch (err) {
		console.error('StageHopper Lambda error:', err);
		return serverError();
	}
};
