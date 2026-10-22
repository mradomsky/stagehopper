/**
 * @file StageHopper API Lambda.
 *
 * Fronted by API Gateway (HTTP API, payload v2). DynamoDB tables back it: `USERS_TABLE`
 * holds one row per user (PK userId) with their identity and notification settings,
 * `PICKS_TABLE` their Festival Picks, `MESSAGES_TABLE` the Festival chat, and
 * `PUSH_SUBSCRIPTIONS_TABLE` one Web Push subscription per device (userId, endpoint).
 *
 * Authentication happens at the gateway, not here. A JWT authorizer verifies the Clerk
 * session token on every route except the public Festival reads (Picks, chat, summary), and the
 * admin routes additionally demand an `admin` scope — so an unauthenticated or non-admin request never
 * reaches this code. What arrives is `event.requestContext.authorizer.jwt.claims`: claims
 * API Gateway verified and a client cannot forge.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
	DynamoDBDocumentClient,
	QueryCommand,
	ScanCommand,
	BatchWriteCommand,
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
import {
	FESTIVAL_ID_REGEX,
	ISO_DATE_REGEX,
	isValidTimeZone,
	toManifestEntry,
	validateFestivalRecord,
	validateStageOrder,
	type FestivalRecord
} from '../shared/festival-fields.js';
import { collect, paginate } from '../shared/dynamo-paginate.js';
import {
	listPicksFestivalIds,
	resolveAttendee,
	setAttendeeColour,
	type AttendeeResult
} from './attendee.js';
import {
	deleteMessage,
	festivalSummary,
	listMessageKeysOf,
	listMessages,
	postMessage,
	type ChatError
} from './chat.js';
import {
	PERFORMANCE_OPTIONAL_STRING_FIELDS,
	type PerformanceOptionalStringField,
	type PublishedPerformance,
	type PublishedTimetable
} from '../shared/timetable-file.js';

export { isValidTimeZone };

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);
const s3 = new S3Client({});
const cloudfront = new CloudFrontClient({});
const lambda = new LambdaClient({});

/**
 * One row per user (PK userId): `{ name, email, lastActive, ...notification settings }`.
 * Notification settings (`enabled`, `leadMinutes`, `notifyMaybe`, `notifyOverrides`) live on
 * the same row.
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
 * republished copy the Festival page and notifier read.
 */
const PERFORMANCES_TABLE = process.env.PERFORMANCES_TABLE;
/**
 * One row per (Festival, user) (PK `festivalId`, SK `userId`): `{ handle, colour, selections,
 * updatedAt }` — a user's Picks for a Festival's Performances. `handle` and `colour` are
 * copies of the user row's, kept fresh by `lambda/attendee.ts` through the `userId-index` GSI.
 * The admin timetable re-import is gated on it: a row of Picks is keyed by Performance ids a
 * re-import would replace.
 */
const PICKS_TABLE = process.env.PICKS_TABLE;
/**
 * One row per Festival chat Message (PK `festivalId`, SK `messageId`); see `lambda/chat.ts`.
 * Admin Festival delete removes a Festival's rows. No fallback name: unset, the chat routes
 * and Festival delete fail.
 */
const MESSAGES_TABLE = process.env.MESSAGES_TABLE;
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

const MAX_SELECTION_KEY_LENGTH = 100;
/** A festival has a few thousand performances, so this is far above any honest client. */
const MAX_SELECTION_ENTRIES = 5000;
/**
 * DynamoDB rejects items over 400 KB. The entry count alone does not bound the item
 * (5000 keys of 100 chars is already ~500 KB), so the serialized size is checked too —
 * otherwise a hostile client turns an oversized write into a 500 instead of a 400.
 */
const MAX_SELECTIONS_BYTES = 300_000;

/**
 * What API Gateway delivers. `authorizer` is optional because the public Festival
 * reads (Picks, chat, summary) have no authorizer attached and genuinely arrive
 * without it. Every other route is guaranteed to carry verified claims.
 */
type StagehopperEvent = APIGatewayProxyEventV2 & {
	requestContext: { authorizer?: { jwt?: { claims?: Record<string, unknown> } } };
};

/** A caller, as the gateway's verified claims describe them. */
export interface Identity {
	/** `clerk:${sub}` — PK of `users`, PK of subscriptions. */
	participantKey: string;
	/** The token's `name` claim, truncated; may be empty. */
	name: string;
	/** The token's `username` claim (Clerk handle), trimmed; empty when the template lacks it. */
	handle: string;
	/** The token's `email` claim, lowercased; may be empty. */
	email: string;
	/** The token's `scope` claim, split on whitespace. */
	scopes: string[];
}

/** Longest an Attendee's name may be. The Lambda truncates rather than rejects: it arrives from a verified token claim, not a form. */
const MAX_NAME_LENGTH = 50;

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

/** The rules a per-Performance pick map must meet, for Festival Picks. */
function validateSelections(selections: unknown): string | null {
	if (!selections || typeof selections !== 'object' || Array.isArray(selections)) {
		return 'selections must be an object';
	}
	const entries = Object.entries(selections);
	if (entries.length > MAX_SELECTION_ENTRIES) return 'too many selections';
	if (JSON.stringify(selections).length > MAX_SELECTIONS_BYTES) {
		return 'selections payload is too large';
	}
	for (const [key, value] of entries) {
		if (key.length === 0 || key.length > MAX_SELECTION_KEY_LENGTH) return 'invalid selection key';
		if (value !== 0 && value !== 1 && value !== 2) return 'selection values must be 0, 1, or 2';
	}
	return null;
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
		handle: typeof claims.username === 'string' ? claims.username.trim() : '',
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

/** What {@link resolveAdminWrite} reads off the event, beyond the caller's identity. */
interface AdminWriteOptions {
	/**
	 * Read `pathParameters.id` and check its shape, rejecting a bad one with 400. The
	 * resolved id is only present on the result when this is set, so a route cannot read an
	 * id it never asked for.
	 */
	festivalId?: boolean;
	/** Parse the JSON body, rejecting a malformed one with 400. Default true. */
	body?: boolean;
}

/**
 * The opening every write route shares: the festival id in the path, then the caller, then
 * the body. Six admin routes and the four notification routes ran the same three checks in
 * the same order, and the order is part of the contract — a malformed id answers 400 before
 * the token is looked at here. (On admin routes the router's {@link requireAdmin} has
 * already checked the caller by then, so there it is 401/403 first, then 400.)
 *
 * Deliberately stops at the checks. What follows genuinely differs per route: each has its
 * own DynamoDB operation, its own mapping of a failed condition to 404 or 409, and its own
 * response shape. A wrapper covering those too would need enough options to be worth less
 * than the code it replaced — `bestEffortPublish` is the warning, since one caller already
 * has to bypass it for being a notch too narrow.
 */
function resolveAdminWrite(
	event: StagehopperEvent,
	options: AdminWriteOptions & { festivalId: true }
): { festivalId: string; identity: Identity; parsed: unknown } | { error: APIGatewayProxyResultV2 };
function resolveAdminWrite(
	event: StagehopperEvent,
	options?: AdminWriteOptions & { festivalId?: false }
): { identity: Identity; parsed: unknown } | { error: APIGatewayProxyResultV2 };
function resolveAdminWrite(
	event: StagehopperEvent,
	options: AdminWriteOptions = {}
): { festivalId?: string; identity: Identity; parsed: unknown } | { error: APIGatewayProxyResultV2 } {
	let festivalId: string | undefined;
	if (options.festivalId) {
		const id = event.pathParameters?.id;
		if (!id || !FESTIVAL_ID_REGEX.test(id)) return { error: badRequest('Invalid festival id') };
		festivalId = id;
	}

	const auth = requireIdentity(event);
	if ('error' in auth) return auth;

	let parsed: unknown = null;
	if (options.body !== false) {
		const body = parseJsonBody(event.body);
		if (body.error) return { error: badRequest(body.error) };
		parsed = body.parsed;
	}

	return { festivalId, identity: auth.identity, parsed };
}

/** Whether the caller carries the `admin` scope. */
export function hasAdminScope(identity: Identity): boolean {
	return identity.scopes.includes('admin');
}

/**
 * The admin gate, applied by the router to every `/admin/*` route but `GET /admin/me`.
 *
 * This duplicates `authorization_scopes = ["admin"]` on each `aws_apigatewayv2_route` in the
 * infrastructure repo, on purpose (#159). Those declarations were the only thing between any
 * signed-in user and deleting every festival, and nothing in this repo could fail if one was
 * dropped — a catch-all route (#123) would drop all of them at once. Two copies of the rule
 * can disagree; the failure that buys is a 403 an admin can report, not a hole nobody sees.
 *
 * Keyed on the path prefix rather than called per handler, so a new admin route is gated
 * without anyone remembering to. `/admin/me` is exempt because answering "no" to a
 * non-admin is its entire purpose.
 */
function requireAdmin(
	routeKey: string,
	event: StagehopperEvent
): APIGatewayProxyResultV2 | null {
	if (!routeKey.includes(' /api/stagehopper/admin/')) return null;
	if (routeKey === 'GET /api/stagehopper/admin/me') return null;

	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;
	// 403, not 401: the token is fine, so re-authenticating would only loop.
	if (!hasAdminScope(auth.identity)) return forbidden({ error: 'Not an admin' });
	return null;
}

// ---- Routes ----

/**
 * Report whether the caller may use the admin console.
 *
 * This is the one `/admin/*` route with no `authorization_scopes` on it: gating it on the
 * `admin` scope would make it unable to tell a non-admin so. It decides presentation only
 * — the bundle is static and can be edited by anyone; every other admin route is enforced by
 * the gateway and again by {@link requireAdmin}.
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
 * Every field a visitor might see (see {@link publishFestivalsManifest}) — the full record,
 * including fields no visitor needs, lives in {@link FESTIVALS_TABLE} and the admin-only
 * `GET /admin/festivals`.
 */
const FESTIVALS_MANIFEST_S3_KEY = 'data/festivals/index.json';

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
 * Run a publishing step whose failure must not fail the request, reporting whether it worked.
 *
 * By the time any of these run the write has already committed: DynamoDB is the source of
 * truth and the file in S3 is a derived copy, so a failed publish leaves a stale public file,
 * never a lost edit. Failing the whole request would be a lie. Returning the outcome instead
 * is what lets the response tell the admin the difference — which is why this is a boolean
 * and not a swallowed error.
 */
async function bestEffortPublish(
	failureMessage: string,
	publish: () => Promise<unknown>
): Promise<boolean> {
	try {
		await publish();
		return true;
	} catch (err) {
		console.error(failureMessage, err);
		return false;
	}
}

/**
 * Rebuild and republish the public manifest from every row in {@link FESTIVALS_TABLE}.
 * Called after any festival create/update/delete. An unpaginated `Scan` is fine here —
 * unlike the users table this scans dozens of festivals at most, never thousands.
 *
 * The read is strongly consistent because it runs in the same request as the write it is
 * publishing. A default eventually-consistent Scan may not see that write, and the manifest
 * it builds would then silently omit the admin's edit — indistinguishable from a successful
 * publish, and self-correcting only whenever some later write happens to republish. Admin
 * traffic is a handful of requests a day, so the doubled read cost is not a consideration.
 */
async function publishFestivalsManifest(): Promise<void> {
	const result = await ddb.send(new ScanCommand({ TableName: FESTIVALS_TABLE, ConsistentRead: true }));
	const manifest: FestivalRecord[] = [];
	for (const item of result.Items ?? []) {
		const entry = toManifestEntry(item);
		if (entry) manifest.push(entry);
		else console.error('Skipping malformed festival row in manifest:', item?.id);
	}
	await publishJsonToS3(FESTIVALS_MANIFEST_S3_KEY, manifest);
}

/**
 * What a `{"republish":"festivals-manifest"}` direct invoke answers with. Not an HTTP
 * shape: this path is never reachable through API Gateway.
 */
export interface RepublishResult {
	ok: boolean;
	key: string;
	error?: string;
}

/**
 * Rebuild the public manifest on demand, outside any admin write.
 *
 * The manifest is a *derived* artifact whose shape is decided by the code in
 * {@link publishFestivalsManifest} but whose content is only rewritten when an admin saves
 * a festival. Ship a Lambda that adds a field to it and the live file keeps the old shape
 * until somebody happens to edit a festival — which is exactly how `description` stayed
 * invisible on the festival page after the release that started publishing it. The deploy
 * workflow invokes this right after updating the function code so the published copy can
 * never lag the code that generates it.
 *
 * Timetables are deliberately left alone: republishing one for a festival that has no
 * performances yet would create an empty `days: []` file where the app currently expects a
 * 404, so they stay tied to their own admin writes.
 */
async function republishFestivalsManifest(): Promise<RepublishResult> {
	try {
		await publishFestivalsManifest();
		return { ok: true, key: FESTIVALS_MANIFEST_S3_KEY };
	} catch (err) {
		console.error('Manifest republish failed:', err);
		return { ok: false, key: FESTIVALS_MANIFEST_S3_KEY, error: String(err) };
	}
}

/**
 * The full festival list, read through the API — admin only. `GET /data/festivals/index.json`
 * off CloudFront is the public equivalent (see {@link publishFestivalsManifest}); this reads
 * straight from {@link FESTIVALS_TABLE} instead, so the editor never renders a stale or
 * truncated edge copy of a record it's about to overwrite.
 */
async function getAdminFestivals(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;

	try {
		const result = await ddb.send(new ScanCommand({ TableName: FESTIVALS_TABLE, ConsistentRead: true }));
		return ok({ festivals: (result.Items ?? []) as FestivalRecord[] });
	} catch (err) {
		console.error('Failed to scan festivals:', err);
		return serverError();
	}
}

/** Create a new festival. `id` is admin-chosen and write-once (see {@link FestivalRecord}). */
async function createFestival(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const resolved = resolveAdminWrite(event);
	if ('error' in resolved) return resolved.error;

	const validated = validateFestivalRecord(resolved.parsed);
	if (validated.error) return badRequest(validated.error);
	const record = validated.record;

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

	const published = await bestEffortPublish(
		'Festival created, but publishing the manifest failed:',
		publishFestivalsManifest
	);
	return created({ ok: true, festival: record, published });
}

/** Update an existing festival. `id` comes from the path and is immutable, not the body. */
async function updateFestival(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const resolved = resolveAdminWrite(event, { festivalId: true });
	if ('error' in resolved) return resolved.error;
	const { festivalId } = resolved;


	const validated = validateFestivalRecord({
		...(resolved.parsed as Record<string, unknown> | null),
		id: festivalId
	});
	if (validated.error) return badRequest(validated.error);
	const record = validated.record;

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

	const published = await bestEffortPublish(
		'Festival updated, but publishing the manifest failed:',
		publishFestivalsManifest
	);
	return ok({ ok: true, festival: record, published });
}

/**
 * Update a festival's manual stage display order. A dedicated endpoint rather than routing
 * through {@link updateFestival}: the drag-to-reorder UI saves on every drop, and resending
 * (and risking dropping) the entire record — `name`, `mapUrl`, `description`, etc. — on every
 * drag would make that unsafe. This only ever touches the `stageOrder` attribute.
 */
async function updateFestivalStageOrder(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const resolved = resolveAdminWrite(event, { festivalId: true });
	if ('error' in resolved) return resolved.error;
	const { festivalId, parsed } = resolved;

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

	const published = await bestEffortPublish(
		'Festival stage order updated, but publishing the manifest failed:',
		publishFestivalsManifest
	);
	return ok({ ok: true, stageOrder, published });
}

/**
 * Delete a festival: its row, every performance on its timetable, its Picks rows, its chat Messages, and both
 * derived public artifacts. Notification overrides keyed by this festival's performance ids are
 * left alone — same "not cleaned up" tradeoff the per-performance delete already makes (see the
 * timetable editor's delete-confirmation copy).
 */
async function deleteFestival(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const resolved = resolveAdminWrite(event, { festivalId: true, body: false });
	if ('error' in resolved) return resolved.error;
	const { festivalId } = resolved;

	try {
		await ddb.send(new DeleteCommand({ TableName: FESTIVALS_TABLE, Key: { id: festivalId } }));

		const performances = await queryAllKeys(PERFORMANCES_TABLE, 'festivalId', festivalId, 'id');
		const performanceIds = performances
			.map((item) => (item as { id?: string }).id)
			.filter((id): id is string => !!id);
		await batchDelete(
			performanceIds.map((id) => ({ table: PERFORMANCES_TABLE as string, key: { festivalId, id } }))
		);
		// A deleted Festival must not keep public Picks, nor block a reused id from re-import.
		const picks = await queryAllKeys(PICKS_TABLE, 'festivalId', festivalId, 'userId');
		await batchDelete(
			picks.map((row) => ({
				table: PICKS_TABLE as string,
				key: { festivalId, userId: (row as { userId: string }).userId }
			}))
		);
		const chatMessages = await queryAllKeys(MESSAGES_TABLE, 'festivalId', festivalId, 'messageId');
		await batchDelete(
			chatMessages.map((row) => ({
				table: MESSAGES_TABLE as string,
				key: { festivalId, messageId: (row as { messageId: string }).messageId }
			}))
		);
	} catch (err) {
		console.error('Failed to delete festival:', err);
		return serverError();
	}

	// The delete itself already succeeded above — a failure publishing either derived
	// artifact from here on is reported to the caller, not turned into a 500 that would
	// wrongly suggest the festival is still there.
	// Both run: the second is not conditional on the first, so no short-circuiting here.
	const manifestPublished = await bestEffortPublish(
		'Festival deleted, but republishing the manifest failed:',
		publishFestivalsManifest
	);
	const timetableRemoved = await bestEffortPublish(
		'Festival deleted, but removing its published timetable failed:',
		() => unpublishFromS3(timetableS3Key(festivalId))
	);
	const published = manifestPublished && timetableRemoved;

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
 * Presign a direct-to-S3 upload for one of a festival's images, under `keyPrefix`.
 *
 * Bytes never pass through this Lambda — no API Gateway payload ceiling, no base64
 * inflation. `ContentType` and `ContentLength` are baked into the signed request itself
 * (not just checked here and forgotten): S3 rejects the browser's PUT outright if either
 * doesn't match exactly what was validated, so the constraint holds even though the
 * Lambda never sees the bytes. The key includes a random suffix rather than the
 * `id` alone, so replacing an image is a new key — nothing needs invalidating, the old
 * object is simply orphaned.
 *
 * The cover image and the map differ only in that prefix, so they share this. The response
 * field stays `imageUrl` for both, map included: a client bundle already in a service
 * worker's cache reads that name, and the map form assigns it to `mapUrl` on arrival.
 */
async function presignFestivalUpload(
	event: StagehopperEvent,
	keyPrefix: string,
	subject: string
): Promise<APIGatewayProxyResultV2> {
	const resolved = resolveAdminWrite(event, { festivalId: true });
	if ('error' in resolved) return resolved.error;
	const { festivalId, parsed } = resolved;

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
	const key = `${keyPrefix}/${festivalId}-${randomBytes(8).toString('hex')}.${extension}`;

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
		console.error(`Failed to presign a festival ${subject} upload:`, err);
		return serverError();
	}
}

// ---- Admin: timetable import ----

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The optional free-text fields a performance carries beyond the four required ones, now in
 * `shared/timetable-file.ts` because the SPA enumerates them too.
 *
 * Everything here derives from that one list: the upload payload type below, the copy the
 * importer keeps, the editable-field allowlist, the patch validator and the item builder.
 * They used to be five hand-written enumerations, which is how a field could be storable,
 * editable and validated yet never survive an import — spotify, youtube and soundcloud all
 * were, for the whole life of the feature.
 */

/**
 * What this Lambda publishes, and what the notifier and the SPA read back — one shape, in
 * `shared/timetable-file.ts`. The *upload* types below stay local: they describe untrusted
 * input, which is why their optional fields are `unknown` rather than strings.
 */
type TimetableImportPayload = PublishedTimetable;

interface TimetableUploadPerformance
	extends Partial<Record<PerformanceOptionalStringField, unknown>> {
	artist: string;
	stage: string;
	startTime: string;
	endTime: string;
	artists?: unknown;
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
 * Assign every performance a fresh id — random hex — regardless of anything the upload supplied. Ids only
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
			// Built field by field rather than spread: the upload is parsed JSON, so anything
			// the file happens to carry — including an `id` its type says it should not have,
			// and any attribute nobody has ever heard of — would otherwise ride straight into
			// DynamoDB and out into the public timetable. The importer decides ids, and this
			// list decides fields.
			performances: day.performances.map((perf) => {
				const imported: PublishedPerformance = {
					id: nextId(),
					artist: perf.artist,
					stage: perf.stage,
					startTime: perf.startTime,
					endTime: perf.endTime,
					...(perf.artists !== undefined && { artists: perf.artists })
				};
				for (const field of PERFORMANCE_OPTIONAL_STRING_FIELDS) {
					// The upload's optional fields are `unknown` — it is untrusted input. The
					// published shape says string, so the copy narrows rather than asserts.
					const value = perf[field];
					if (typeof value === 'string') imported[field] = value;
				}
				return imported;
			})
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
	return collect(
		paginate<PerformanceItem>(
			ddb,
			(startKey) =>
				new QueryCommand({
					TableName: PERFORMANCES_TABLE,
					KeyConditionExpression: 'festivalId = :fid',
					ExpressionAttributeValues: { ':fid': festivalId },
					ConsistentRead: true,
					ExclusiveStartKey: startKey
				})
		)
	);
}

/** Group flat performance rows back into the canonical v1 `days` shape, for publishing. */
function assembleTimetable(festivalId: string, items: PerformanceItem[]): TimetableImportPayload {
	const byDate = new Map<string, PublishedPerformance[]>();
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
 * Whether anyone has Picks for this festival. Fails closed: with {@link PICKS_TABLE} unset the
 * answer is "yes", so a misconfigured deploy refuses a re-import instead of orphaning Picks.
 * Strongly consistent: this gate stands between a re-import and every pick, and a stale read fails it open.
 */
async function festivalHasPicks(festivalId: string): Promise<boolean> {
	if (!PICKS_TABLE) {
		console.error('PICKS_TABLE is not set; refusing timetable re-import');
		return true;
	}
	const result = await ddb.send(
		new QueryCommand({
			TableName: PICKS_TABLE,
			KeyConditionExpression: 'festivalId = :fid',
			ExpressionAttributeValues: { ':fid': festivalId },
			Limit: 1,
			ConsistentRead: true
		})
	);
	return (result.Items ?? []).length > 0;
}

/**
 * Drop stage colours and stage-order entries for stages the new timetable no longer has.
 *
 * Both are keyed by stage *name*, not by anything the import re-keys, so every stage still
 * standing keeps its colour and its place — which is what an admin who re-imported to fix
 * three set times expects to happen. Only the ghosts go, so the festival record stops
 * accumulating stages that no longer exist.
 *
 * Best-effort by design: the timetable is already written by the time this runs, and a stale
 * colour is not worth failing an import over.
 */
async function pruneFestivalStages(festivalId: string, stages: Set<string>): Promise<void> {
	const existing = await ddb.send(
		new GetCommand({ TableName: FESTIVALS_TABLE, Key: { id: festivalId } })
	);
	const item = existing.Item as FestivalRecord | undefined;
	if (!item) return;

	const colors =
		item.stageColors && typeof item.stageColors === 'object' && !Array.isArray(item.stageColors)
			? (item.stageColors as Record<string, string>)
			: null;
	const order = Array.isArray(item.stageOrder) ? (item.stageOrder as string[]) : null;

	const sets: string[] = [];
	const values: Record<string, unknown> = {};

	if (colors) {
		const kept = Object.fromEntries(
			Object.entries(colors).filter(([stage]) => stages.has(stage))
		);
		if (Object.keys(kept).length !== Object.keys(colors).length) {
			sets.push('stageColors = :colors');
			values[':colors'] = kept;
		}
	}
	if (order) {
		const kept = order.filter((stage) => stages.has(stage));
		if (kept.length !== order.length) {
			sets.push('stageOrder = :order');
			values[':order'] = kept;
		}
	}
	if (sets.length === 0) return;

	await ddb.send(
		new UpdateCommand({
			TableName: FESTIVALS_TABLE,
			Key: { id: festivalId },
			UpdateExpression: `SET ${sets.join(', ')}`,
			ExpressionAttributeValues: values
		})
	);
}

/**
 * Import a festival's timetable.
 *
 * Write-once by default, unchanged: with no `replace`, a festival that already has
 * performances gets a 409. The importer assigns every performance a fresh id regardless of
 * what the file carries ({@link assignPerformanceIds}), so a second import re-keys the whole
 * timetable — and every pick and notification override is keyed by a performance
 * id. Replacing a timetable under live Picks orphans all of them with no error anywhere; the
 * picks simply stop pointing at anything.
 *
 * `replace: true` opts into that rewrite deliberately, and is refused outright while anyone has
 * Picks for the festival ({@link festivalHasPicks}). There is no override.
 *
 * The order below is the contract, not an accident — validate, assign ids, delete, insert,
 * prune stage state, publish *last*. A delete and an insert of this size cannot be one
 * transaction, so the guarantee on offer is that nothing public moves until DynamoDB has
 * settled: a failure part-way leaves visitors on the old published timetable, and the admin
 * one retry away, since under `replace: true` there is nothing left for a retry to conflict
 * with. Delete-then-insert rather than the reverse for the same reason — its failure state is
 * a short timetable, which reads as obviously wrong, not a doubled one, which does not.
 */
async function importFestivalTimetable(
	event: StagehopperEvent
): Promise<APIGatewayProxyResultV2> {
	const resolved = resolveAdminWrite(event, { festivalId: true });
	if ('error' in resolved) return resolved.error;
	const { festivalId, parsed } = resolved;

	const body = (parsed as { timetable?: unknown; replace?: unknown } | null) ?? {};
	if (body.replace !== undefined && typeof body.replace !== 'boolean') {
		return badRequest('replace must be a boolean');
	}
	const replace = body.replace === true;

	const validated = validateTimetableUploadPayload(body.timetable);
	if (validated.error || !validated.data) return badRequest(validated.error ?? 'Invalid timetable');
	if (validated.data.festivalId !== festivalId) {
		return badRequest('festivalId in the file does not match the festival being imported into');
	}

	// Ids of what is being replaced. Empty on a first import, which is also the only case that
	// needs no gate: there are no picks to orphan when there is no timetable to re-key.
	let doomedIds: string[] = [];
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
			if (!replace) {
				return jsonResponse(409, { error: 'A timetable already exists for this festival' });
			}
			if (await festivalHasPicks(festivalId)) {
				return jsonResponse(409, {
					error:
						'Festival schedule cannot be re-imported, since there are existing festival picks.'
				});
			}
			// Only now is the full key list worth paging for.
			doomedIds = (await queryAllKeys(PERFORMANCES_TABLE, 'festivalId', festivalId, 'id'))
				.map((item) => (item as { id?: string }).id)
				.filter((id): id is string => !!id);
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
		if (doomedIds.length > 0) {
			await batchDelete(
				doomedIds.map((id) => ({ table: PERFORMANCES_TABLE as string, key: { festivalId, id } }))
			);
		}
		await batchPut(PERFORMANCES_TABLE as string, items);
	} catch (err) {
		console.error('Failed to write timetable performances:', err);
		// The published file has not been touched, so visitors are still on the old timetable and
		// re-running the same import is the whole recovery.
		return jsonResponse(500, {
			error: 'The timetable could not be written. Nothing has been published — import again.'
		});
	}

	try {
		await pruneFestivalStages(
			festivalId,
			new Set(items.map((item) => item.stage as string))
		);
	} catch (err) {
		console.error('Timetable imported, but pruning stale stage settings failed:', err);
	}

	const published = await bestEffortPublish('Timetable saved, but publishing it failed:', () =>
		publishFestivalTimetable(festivalId)
	);

	return ok({ ok: true, published, replaced: doomedIds.length });
}

// ---- Admin: per-performance timetable editing ----

const REQUIRED_ON_ADD = ['artist', 'stage', 'startTime', 'endTime'] as const;
const EDITABLE_PERFORMANCE_FIELDS = new Set<string>([
	...REQUIRED_ON_ADD,
	...PERFORMANCE_OPTIONAL_STRING_FIELDS
]);

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
	for (const field of PERFORMANCE_OPTIONAL_STRING_FIELDS) {
		if (field in patch && typeof patch[field] !== 'string') return field + ' must be a string';
	}
	return null;
}

function buildPerformanceItem(
	festivalId: string,
	id: string,
	date: string,
	patch: Record<string, unknown>
): PerformanceItem {
	const item: PerformanceItem = {
		festivalId,
		id,
		date,
		artist: patch.artist as string,
		stage: patch.stage as string,
		startTime: patch.startTime as string,
		endTime: patch.endTime as string
	};
	for (const field of PERFORMANCE_OPTIONAL_STRING_FIELDS) {
		const value = patch[field];
		if (typeof value === 'string') item[field] = value;
	}
	return item;
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
	const resolved = resolveAdminWrite(event, { festivalId: true });
	if ('error' in resolved) return resolved.error;
	const { festivalId, parsed } = resolved;

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

	// Not bestEffortPublish: this one needs the publisher's return value, and on failure it
	// still has to answer with a timetable — rebuilt from the table — so the editor can render
	// the write that did land. A helper that only reports success could not do either.
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

// ---- Admin: browse and delete users ----

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

/** A row in the users table (PK userId): identity and notification settings. */
interface UserRow {
	userId?: string;
	name?: unknown;
	email?: unknown;
	lastActive?: unknown;
	/** Set (to true) by an Admin's ban; absent otherwise. */
	banned?: unknown;
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
 * List users — one scanned page, one entry per user row. A user row is created by the
 * first Picks save, chat Message or push subscription, so a user who has done none of those
 * does not appear.
 */
async function listAdminUsers(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;

	const { rows, nextKey } = await scanUsersPage(readAdminStartKey(event));

	const users = rows
		.filter((row) => row.userId)
		.map((row) => ({
			userId: row.userId as string,
			name: toStr(row.name),
			email: toStr(row.email),
			lastActive: toNumber(row.lastActive),
			banned: row.banned === true
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
	return collect(
		paginate<Record<string, unknown>>(
			ddb,
			(startKey) =>
				new QueryCommand({
					TableName: table,
					KeyConditionExpression: '#k = :v',
					ExpressionAttributeNames: { '#k': keyName },
					ExpressionAttributeValues: { ':v': keyValue },
					ProjectionExpression: project,
					ExclusiveStartKey: startKey
				})
		)
	);
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
 * Hard-delete a user: their user row (which carries their notification settings), their
 * Picks, their chat Messages and their push subscriptions.
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
		const subs = await queryAllKeys(PUSH_SUBSCRIPTIONS_TABLE, 'userId', userId, 'endpoint');
		const pickedFestivalIds = await listPicksFestivalIds(userId);
		const messageKeys = await listMessageKeysOf(userId);
		// Deleting a Banned user must not lift the ban: their row is replaced by a tombstone below.
		const banned = userRow.Item?.banned === true;

		const deletes = [
			...pickedFestivalIds.map((festivalId) => ({
				table: PICKS_TABLE as string,
				key: { festivalId, userId }
			})),
			...messageKeys.map((key) => ({ table: MESSAGES_TABLE as string, key })),
			...(banned ? [] : [{ table: USERS_TABLE as string, key: { userId } }]),
			...subs.map((s) => ({
				table: PUSH_SUBSCRIPTIONS_TABLE as string,
				key: { userId, endpoint: (s as { endpoint?: string }).endpoint }
			}))
		];
		await batchDelete(deletes);
		if (banned) {
			await ddb.send(new PutCommand({ TableName: USERS_TABLE, Item: { userId, banned: true } }));
		}
		console.log(
			`Admin ${auth.identity.email} hard-deleted user ${userId} (${pickedFestivalIds.length} Picks rows, ${messageKeys.length} Messages)`
		);
		return ok({ ok: true });
	} catch (err) {
		console.error('Failed to delete user:', err);
		return serverError();
	}
}

/**
 * Ban (`SET banned`) or unban (`REMOVE banned`) a user. Guarded by `attribute_exists`, so an
 * unknown id is a 404 and never a phantom row. An Admin cannot ban themselves; unbanning
 * themselves is allowed.
 */
async function setAdminUserBan(
	event: StagehopperEvent,
	banned: boolean
): Promise<APIGatewayProxyResultV2> {
	const userId = event.pathParameters?.userId;
	if (!userId || !USER_ID_REGEX.test(userId)) return badRequest('Invalid userId');

	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;
	if (banned && userId === auth.identity.participantKey) return badRequest('You cannot ban yourself');

	try {
		await ddb.send(
			new UpdateCommand({
				TableName: USERS_TABLE,
				Key: { userId },
				UpdateExpression: banned ? 'SET banned = :t' : 'REMOVE banned',
				ConditionExpression: 'attribute_exists(userId)',
				...(banned && { ExpressionAttributeValues: { ':t': true } })
			})
		);
		console.log(`Admin ${auth.identity.email} ${banned ? 'banned' : 'unbanned'} user ${userId}`);
		return ok({ ok: true, userId, banned });
	} catch (err) {
		if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
			return jsonResponse(404, { error: 'User not found' });
		}
		console.error('Failed to set ban:', err);
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
	const resolved = resolveAdminWrite(event);
	if ('error' in resolved) return resolved;
	return { userId: resolved.identity.participantKey, parsed: resolved.parsed };
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
 * `notifyOverrides` map is seeded when a device subscribes (see `addPushSubscription`), and the app only offers
 * overrides once one has, so a nested per-key SET here can assume it already exists.
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
 * A direct (non-gateway) invoke. Only the deploy workflow sends one, and it carries no
 * `routeKey` — nothing reaching this function through API Gateway can ever match, because
 * every gateway event has one.
 */
type MaintenanceEvent = { republish?: string };

// ---- Festival Picks and Attendee profile ----

/** An {@link AttendeeResult} failure as the response to send. */
function attendeeFailure(result: Extract<AttendeeResult, { error: unknown }>) {
	return badRequest(result.error.message);
}

/** A Festival's Picks, grouped by Performance: who picked it, in what colour, and how. */
async function getFestivalPicks(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const festivalId = event.pathParameters?.id;
	if (!festivalId || !FESTIVAL_ID_REGEX.test(festivalId)) return badRequest('Invalid festival id');

	// shortcut: no response size cap — 6 MB Lambda limit; page or cache if a Festival nears it.
	const rows = await collect(
		paginate<{ userId?: string; handle?: string; colour?: string; selections?: Record<string, number> }>(
			ddb,
			(startKey) =>
				new QueryCommand({
					TableName: PICKS_TABLE,
					KeyConditionExpression: 'festivalId = :fid',
					ExpressionAttributeValues: { ':fid': festivalId },
					ExclusiveStartKey: startKey
				})
		)
	);

	// 200 with {} when nobody has picked: CloudFront turns an /api/* 404 into HTML (#181).
	const picks: Record<string, { userId: string; handle: string; colour: string; state: number }[]> = {};
	for (const row of rows) {
		for (const [performanceId, state] of Object.entries(row.selections ?? {})) {
			if (state !== 1 && state !== 2) continue;
			(picks[performanceId] ??= []).push({
				userId: row.userId ?? '',
				handle: row.handle ?? '',
				colour: row.colour ?? '',
				state
			});
		}
	}
	return ok(picks);
}

/** The caller's own pick map for a Festival, so a client can edit without wiping the rest. */
async function getMyFestivalPicks(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const festivalId = event.pathParameters?.id;
	if (!festivalId || !FESTIVAL_ID_REGEX.test(festivalId)) return badRequest('Invalid festival id');
	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;

	const result = await ddb.send(
		new GetCommand({
			TableName: PICKS_TABLE,
			Key: { festivalId, userId: auth.identity.participantKey }
		})
	);
	return ok({ selections: result.Item?.selections ?? {} });
}

/**
 * Replace the caller's whole pick map for a Festival. States of 0 are dropped, and a map
 * left empty deletes the row: an empty row would block a timetable re-import and count as
 * an Attendee for nothing. Other body keys are ignored.
 */
async function putFestivalPicks(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const resolved = resolveAdminWrite(event, { festivalId: true });
	if ('error' in resolved) return resolved.error;
	const { festivalId, identity, parsed } = resolved;

	const rawSelections = (parsed as { selections?: unknown } | null)?.selections;
	const selectionsError = validateSelections(rawSelections);
	if (selectionsError) return badRequest(selectionsError);
	if (!identity.handle) return badRequest('handle is required');

	// Ban before colour (as postMessage does): a Banned user without a colour sees the ban.
	const resolvedAttendee = await resolveAttendee(identity);
	if ('error' in resolvedAttendee) return attendeeFailure(resolvedAttendee);
	const { attendee } = resolvedAttendee;
	if (attendee.banned) return forbidden({ error: 'You are banned' });
	if (!attendee.colour) return badRequest('choose a colour first');

	const selections = Object.fromEntries(
		Object.entries(rawSelections as Record<string, number>).filter(([, state]) => state !== 0)
	);
	const key = { festivalId, userId: attendee.userId };
	if (Object.keys(selections).length === 0) {
		await ddb.send(new DeleteCommand({ TableName: PICKS_TABLE, Key: key }));
	} else {
		await ddb.send(
			new PutCommand({
				TableName: PICKS_TABLE,
				Item: {
					...key,
					handle: attendee.handle,
					colour: attendee.colour,
					selections,
					updatedAt: Date.now()
				}
			})
		);
	}
	return ok({ ok: true });
}

async function getProfile(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const auth = requireIdentity(event);
	if ('error' in auth) return auth.error;

	const result = await ddb.send(
		new GetCommand({ TableName: USERS_TABLE, Key: { userId: auth.identity.participantKey } })
	);
	const colour = result.Item?.colour;
	return ok({ handle: auth.identity.handle, colour: typeof colour === 'string' ? colour : null });
}

/** Choose the caller's colour. A `handle` in the body is ignored: it is read-only, from Clerk. */
async function putProfile(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const resolved = resolveAdminWrite(event);
	if ('error' in resolved) return resolved.error;
	const { identity, parsed } = resolved;
	if (!identity.handle) return badRequest('handle is required');

	const result = await setAttendeeColour(identity, (parsed as { colour?: unknown } | null)?.colour);
	if ('error' in result) return attendeeFailure(result);
	return ok({ handle: result.attendee.handle, colour: result.attendee.colour });
}

// ---- Festival chat ----

/** A {@link ChatError} as the response to send. */
const chatFailure = (error: ChatError) => jsonResponse(error.status, { error: error.message });

async function getFestivalMessages(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const festivalId = event.pathParameters?.id;
	if (!festivalId || !FESTIVAL_ID_REGEX.test(festivalId)) return badRequest('Invalid festival id');

	const { after, before } = event.queryStringParameters ?? {};
	const result = await listMessages(festivalId, { after, before });
	if ('error' in result) return chatFailure(result.error);
	return ok({ messages: result.ok });
}

async function postFestivalMessage(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const resolved = resolveAdminWrite(event, { festivalId: true });
	if ('error' in resolved) return resolved.error;
	const { festivalId, identity, parsed } = resolved;

	const result = await postMessage(identity, festivalId, (parsed as { text?: unknown } | null)?.text);
	if ('error' in result) return chatFailure(result.error);
	return created({ message: result.ok });
}

async function deleteFestivalMessage(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const resolved = resolveAdminWrite(event, { festivalId: true, body: false });
	if ('error' in resolved) return resolved.error;
	const { festivalId, identity } = resolved;

	const result = await deleteMessage(
		identity,
		festivalId,
		event.pathParameters?.messageId ?? '',
		hasAdminScope(identity)
	);
	if ('error' in result) return chatFailure(result.error);
	return ok({ ok: true });
}

async function getFestivalSummary(event: StagehopperEvent): Promise<APIGatewayProxyResultV2> {
	const festivalId = event.pathParameters?.id;
	if (!festivalId || !FESTIVAL_ID_REGEX.test(festivalId)) return badRequest('Invalid festival id');
	return ok(await festivalSummary(festivalId));
}

export const handler = async (
	event: StagehopperEvent & MaintenanceEvent
): Promise<APIGatewayProxyResultV2 | RepublishResult> => {
	const routeKey = event.routeKey;

	// Deploy-time maintenance, before any routing: see {@link republishFestivalsManifest}.
	if (!routeKey && event.republish === 'festivals-manifest') {
		return await republishFestivalsManifest();
	}

	try {
		if (routeKey?.startsWith('OPTIONS ')) return noContent();

		const denied = requireAdmin(routeKey ?? '', event);
		if (denied) return denied;

		// Each route is awaited here, not just returned: a returned promise settles
		// outside this try block, so a DynamoDB failure would escape the catch and
		// surface as a gateway error instead of the JSON 500 below.
		switch (routeKey) {
			case 'GET /api/stagehopper/festivals/{id}/picks':
				return await getFestivalPicks(event);
			case 'GET /api/stagehopper/festivals/{id}/picks/me':
				return await getMyFestivalPicks(event);
			case 'PUT /api/stagehopper/festivals/{id}/picks':
				return await putFestivalPicks(event);
			case 'GET /api/stagehopper/festivals/{id}/messages':
				return await getFestivalMessages(event);
			case 'POST /api/stagehopper/festivals/{id}/messages':
				return await postFestivalMessage(event);
			case 'DELETE /api/stagehopper/festivals/{id}/messages/{messageId}':
				return await deleteFestivalMessage(event);
			case 'GET /api/stagehopper/festivals/{id}/summary':
				return await getFestivalSummary(event);
			case 'GET /api/stagehopper/users/me/profile':
				return await getProfile(event);
			case 'PUT /api/stagehopper/users/me/profile':
				return await putProfile(event);
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
				return await presignFestivalUpload(event, 'data/festival-images', 'cover image');
			case 'POST /api/stagehopper/admin/festivals/{id}/map-upload':
				return await presignFestivalUpload(event, 'data/festival-maps', 'map');
			case 'POST /api/stagehopper/admin/festivals/{id}/timetable-import':
				return await importFestivalTimetable(event);
			case 'PATCH /api/stagehopper/admin/festivals/{id}/timetable':
				return await patchFestivalTimetable(event);
			case 'POST /api/stagehopper/admin/users':
				return await listAdminUsers(event);
			case 'DELETE /api/stagehopper/admin/users/{userId}':
				return await deleteAdminUser(event);
			case 'POST /api/stagehopper/admin/users/{userId}/ban':
				return await setAdminUserBan(event, true);
			case 'DELETE /api/stagehopper/admin/users/{userId}/ban':
				return await setAdminUserBan(event, false);
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
