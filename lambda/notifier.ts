/**
 * @file Scheduled Lambda for sending push notifications.
 *
 * EventBridge invokes this every minute. It scans for users with enabled
 * notifications, checks if any of their marked performances are due to start,
 * and sends web-push notifications via subscriptions.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
	DynamoDBDocumentClient,
	QueryCommand,
	ScanCommand,
	GetCommand,
	PutCommand,
	DeleteCommand
} from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
// @ts-ignore - web-push has no type definitions
import webpush from 'web-push';
import {
	performanceStartUtcMs,
	inCandidateWindow,
	dueNotifications,
	type FestivalCandidates,
	type RoomPicks
} from './schedule.js';
import { getSecret } from './secrets.js';
import type { FestivalRecord } from '../shared/festival-fields.js';
import { festivalIdFromRoomId } from '../shared/room-ids.js';
import { paginate } from '../shared/dynamo-paginate.js';
import type { PublishedTimetable } from '../shared/timetable-file.js';

const dynamodb = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(dynamodb);
const s3 = new S3Client({});

const TABLE = process.env.TABLE_NAME || '';
const USERS_TABLE = process.env.USERS_TABLE || '';
const PUSH_SUBSCRIPTIONS_TABLE = process.env.PUSH_SUBSCRIPTIONS_TABLE || '';
const NOTIF_DEDUP_TABLE = process.env.NOTIF_DEDUP_TABLE || '';
/**
 * One row per room (PK roomId) recording which festival it belongs to — the only place that
 * records it. Empty when the infrastructure change adding it has not been applied yet, which
 * is what {@link roomFestivalId} falls back for.
 */
const ROOMS_TABLE = process.env.ROOMS_TABLE || '';
const SITE_BUCKET = process.env.SITE_BUCKET || '';
/**
 * Name of the SSM `SecureString` holding the VAPID private key — the key itself is
 * never an environment variable, because Terraform would then record it in state.
 * See {@link getSecret}.
 */
const VAPID_PRIVATE_KEY_PARAM = process.env.VAPID_PRIVATE_KEY_PARAM || '';
/** Public by design: the browser receives this to subscribe. */
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
/** A `mailto:` contact the push service can reach. Not a secret. */
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || '';

interface Performance {
	id: string;
	artist: string;
	stage: string;
	startTime: string;
	dayDate: string;
}

interface UserSettings {
	userId: string;
	enabled?: boolean;
	notifyMaybe?: boolean;
	leadMinutes?: number;
	/** Per-performance overrides of the default notify rule, keyed by performance id. */
	notifyOverrides?: Record<string, boolean>;
	/** roomId → per-room metadata; the inverse index of the selections table. */
	rooms?: Record<string, { updatedAt?: number }>;
}

interface PushSubscription {
	endpoint: string;
	p256dh: string;
	auth: string;
}

// Module-level caches
let festivalsCache: FestivalRecord[] | null = null;
const timetablesCache = new Map<string, Performance[]>();

/**
 * Load the published festivals manifest from S3 (cached). This is a derived, republished
 * copy of `stagehopper-festivals` in DynamoDB — the admin API is the write-side source of
 * truth, this Lambda only ever reads the public artifact, same as the landing page.
 */
async function loadFestivals(): Promise<FestivalRecord[]> {
	if (festivalsCache !== null) return festivalsCache;

	try {
		const result = await s3.send(
			new GetObjectCommand({
				Bucket: SITE_BUCKET,
				Key: 'data/festivals/index.json'
			})
		);
		const text = await result.Body?.transformToString();
		festivalsCache = JSON.parse(text || '[]') as FestivalRecord[];
		return festivalsCache;
	} catch (err) {
		console.error('Failed to load festivals:', err);
		festivalsCache = [];
		return [];
	}
}

/**
 * Load a festival's timetable from S3 (cached) — the published, republished-on-every-edit
 * copy of `stagehopper-performances` in DynamoDB.
 */
async function loadTimetable(festivalId: string): Promise<Performance[]> {
	if (timetablesCache.has(festivalId)) {
		return timetablesCache.get(festivalId) || [];
	}

	try {
		const result = await s3.send(
			new GetObjectCommand({
				Bucket: SITE_BUCKET,
				Key: `data/festivals/${festivalId}/timetable.json`
			})
		);
		const text = await result.Body?.transformToString();
		// The published shape, declared once in shared/timetable-file.ts. Flattened here to
		// what this Lambda needs: a set plus the date it belongs to.
		const payload = JSON.parse(text || '{}') as Partial<PublishedTimetable>;

		const performances: Performance[] = [];
		for (const day of payload.days ?? []) {
			for (const perf of day.performances ?? []) {
				performances.push({
					id: perf.id,
					artist: perf.artist,
					stage: perf.stage,
					startTime: perf.startTime,
					dayDate: day.date
				});
			}
		}

		timetablesCache.set(festivalId, performances);
		return performances;
	} catch (err) {
		console.error(`Failed to load timetable for ${festivalId}:`, err);
		return [];
	}
}

/**
 * Whether a festival is worth loading a timetable for right now (in its timezone).
 *
 * The window runs to the day *after* `endDate`, because the timetable's day boundary is
 * 09:00, not midnight: a set listed under the closing day at 01:00 actually happens in the
 * small hours of the next calendar day — `effectiveDate` in schedule.ts rolls it forward.
 * Gating on the raw `endDate` skipped the festival before its timetable was ever loaded,
 * so every post-midnight set on the last night went unnotified, and on a one-day festival
 * that was every post-midnight set it had. `getCandidatePerformances` still bounds the
 * actual sends, so the extra day only ever costs one timetable read.
 */
function isFestivalActive(festival: FestivalRecord, now: Date = new Date()): boolean {
	const tz = festival.timezone || 'Europe/Berlin';
	const formatter = new Intl.DateTimeFormat('en-CA', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	});
	const parts = formatter.formatToParts(now);
	const field = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
	// Build YYYY-MM-DD from the named fields — joining every part (literals included)
	// would splice the format's own separators back in (e.g. "2026---07---18").
	const todayStr = `${field('year')}-${field('month')}-${field('day')}`;

	return todayStr >= festival.startDate && todayStr <= dayAfter(festival.endDate);
}

/** The ISO date one calendar day after `isoDate`. */
function dayAfter(isoDate: string): string {
	const d = new Date(`${isoDate}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + 1);
	return d.toISOString().slice(0, 10);
}

/**
 * Filter performances that are in the candidate window (worth considering).
 */
function getCandidatePerformances(performances: Performance[], nowMs: number, tz: string): Performance[] {
	return performances.filter((perf) => {
		const startMs = performanceStartUtcMs(perf.dayDate, perf.startTime, tz);
		return inCandidateWindow(startMs, nowMs);
	});
}

/**
 * Which festival a room belongs to, or null when nothing says.
 *
 * A festival-prefixed id like `tmr26-1f4c9a` answers this by itself, and the index cannot
 * disagree: `resolveRoomFestivalId` in the API takes the prefix for these and consults
 * nothing else, so the row it writes *is* the prefix. Most rooms are prefixed, so asking
 * DynamoDB first would spend a read per room per tick to be told what the id already says.
 *
 * A custom-slug room — what typing a name into the join box creates — carries nothing, and
 * ROOMS_TABLE is the only thing that knows. Reading the prefix was the old answer for every
 * room, which is why slug rooms were silently excluded from notifications entirely.
 *
 * Slug lookups are cached per invocation: one tick re-asks for the same handful of rooms
 * across many users and performances. Cleared each tick with the other warm-container caches.
 */
const roomFestivalCache = new Map<string, string | null>();

async function roomFestivalId(roomId: string): Promise<string | null> {
	const prefixed = festivalIdFromRoomId(roomId);
	if (prefixed) return prefixed;

	const cached = roomFestivalCache.get(roomId);
	if (cached !== undefined) return cached;

	let festivalId: string | null = null;
	if (ROOMS_TABLE) {
		try {
			const result = await ddb.send(
				new GetCommand({ TableName: ROOMS_TABLE, Key: { roomId } })
			);
			const value = (result.Item as { festivalId?: unknown } | undefined)?.festivalId;
			if (typeof value === 'string' && value) festivalId = value;
		} catch (err) {
			// Swallowed on purpose: a slug room simply goes unnotified this tick, which is the
			// behaviour it had before the index existed. Failing the tick would cost every
			// other room its notifications too.
			console.error(`Failed to read the festival for room ${roomId}:`, err);
		}
	}

	roomFestivalCache.set(roomId, festivalId);
	return festivalId;
}

/**
 * Every pick a user holds in the festivals running right now — one read per room, once.
 *
 * A room's selections row carries every set the user marked in it, so this used to be read
 * once per *candidate performance*: the same row, fetched again for each set in the
 * half-hour window, for every user on every tick. The window holds tens of sets at a busy
 * festival, so the scan was doing roughly that many times more reads than it had rows.
 *
 * Rooms come off the user row and are matched against the rooms index rather than by
 * pattern on the id, so a custom-slug room — which carries no festival prefix — is included
 * instead of silently skipped.
 */
async function loadUserPicks(
	userId: string,
	userRooms: Record<string, { updatedAt?: number }>,
	activeFestivalIds: Set<string>
): Promise<RoomPicks[]> {
	const picks: RoomPicks[] = [];

	// One catch for the lot, as before: a read failure costs this user their notifications
	// for the rest of the tick rather than failing the scan for everybody. The next tick is
	// a minute away and starts over.
	try {
		for (const [roomId, meta] of Object.entries(userRooms)) {
			const festivalId = await roomFestivalId(roomId);
			if (!festivalId || !activeFestivalIds.has(festivalId)) continue;

			const selItem = await ddb.send(
				new GetCommand({ TableName: TABLE, Key: { roomId, userId } })
			);
			const selections = (selItem.Item as { selections?: Record<string, unknown> } | undefined)
				?.selections;

			picks.push({
				roomId,
				festivalId,
				updatedAt: Number(meta?.updatedAt ?? 0),
				selections: selections ?? {}
			});
		}
	} catch (err) {
		console.error(`Error getting picks for user ${userId}:`, err);
	}

	return picks;
}

/**
 * Get push subscriptions for a user.
 */
async function getUserSubscriptions(userId: string): Promise<PushSubscription[]> {
	try {
		const result = await ddb.send(
			new QueryCommand({
				TableName: PUSH_SUBSCRIPTIONS_TABLE,
				KeyConditionExpression: 'userId = :uid',
				ExpressionAttributeValues: { ':uid': userId }
			})
		);

		// Stored shape is { endpoint, keys: { p256dh, auth } } (see addPushSubscription in
		// index.ts) — read the nested keys, not flat fields.
		return (result.Items || []).map((item: any) => ({
			endpoint: item.endpoint,
			p256dh: item.keys?.p256dh,
			auth: item.keys?.auth
		}));
	} catch (err) {
		console.error(`Error getting subscriptions for user ${userId}:`, err);
		return [];
	}
}

/**
 * Send a push notification via web-push.
 * If the subscription is invalid (410 or 404), delete it.
 */
async function sendPushNotification(
	userId: string,
	subscription: PushSubscription,
	payload: Record<string, unknown>
): Promise<boolean> {
	try {
		await (webpush as any).sendNotification(
			{
				endpoint: subscription.endpoint,
				keys: {
					p256dh: subscription.p256dh,
					auth: subscription.auth
				}
			},
			JSON.stringify(payload)
		);
		return true;
	} catch (err: any) {
		const statusCode = err?.statusCode;
		if (statusCode === 404 || statusCode === 410) {
			// Subscription is dead, delete it
			try {
				await ddb.send(
					new DeleteCommand({
						TableName: PUSH_SUBSCRIPTIONS_TABLE,
						Key: { userId, endpoint: subscription.endpoint }
					})
				);
			} catch (delErr) {
				console.error(`Failed to delete subscription for ${userId}:`, delErr);
			}
		}
		console.error(`Failed to send push for ${userId}:`, err);
		return false;
	}
}

/**
 * Try to write to the dedup table. Returns true if written (new), false if it already existed.
 */
async function tryWriteDedup(userId: string, performanceId: string, perfStartMs: number): Promise<boolean> {
	try {
		await ddb.send(
			new PutCommand({
				TableName: NOTIF_DEDUP_TABLE,
				Item: {
					userId,
					performanceId,
					ttl: Math.floor(perfStartMs / 1000) + 6 * 3600 // Start time + 6 hours
				},
				ConditionExpression: 'attribute_not_exists(userId)'
			})
		);
		return true;
	} catch (err: any) {
		if (err?.name === 'ConditionalCheckFailedException') {
			return false; // Already sent
		}
		throw err;
	}
}

/**
 * Remove a dedup row. Used to roll back the claim written by {@link tryWriteDedup}
 * when every push send failed, so the next tick retries instead of dropping it forever.
 */
async function deleteDedup(userId: string, performanceId: string): Promise<void> {
	try {
		await ddb.send(
			new DeleteCommand({
				TableName: NOTIF_DEDUP_TABLE,
				Key: { userId, performanceId }
			})
		);
	} catch (err) {
		console.error(`Failed to roll back dedup for ${userId}/${performanceId}:`, err);
	}
}

/**
 * Initialize web-push with the app-wide VAPID details. The private key comes from SSM on
 * the first call of a cold container and is cached from then on; a failure throws rather
 * than sending nothing while looking healthy.
 */
async function initVapid(): Promise<void> {
	if (VAPID_PRIVATE_KEY_PARAM && VAPID_PUBLIC_KEY && VAPID_SUBJECT) {
		const vapidPrivateKey = await getSecret(VAPID_PRIVATE_KEY_PARAM);
		(webpush as any).setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, vapidPrivateKey);
	}
}

/** The event this Lambda accepts: either the scheduled tick (no fields) or an admin test send. */
interface NotifierEvent {
	/** When true, skip the scan and push a canned notification to {@link userId}'s devices. */
	test?: boolean;
	userId?: string;
}

/** Result of a test send, returned to the synchronous invoker (the admin API route). */
interface TestSendResult {
	ok: boolean;
	sent: number;
	failed: number;
	total: number;
	error?: string;
}

/**
 * Send a canned "notifications are working" push to every device a user has registered.
 * Bypasses all scheduling/dedup — this is the admin's on-demand end-to-end check. Returns
 * per-device counts so the caller can tell "no subscriptions" apart from "all sends failed".
 */
async function sendTestNotification(userId: string): Promise<TestSendResult> {
	await initVapid();
	const subscriptions = await getUserSubscriptions(userId);
	if (subscriptions.length === 0) {
		return { ok: false, sent: 0, failed: 0, total: 0, error: 'No push subscriptions for this user' };
	}

	let sent = 0;
	for (const sub of subscriptions) {
		// roomId omitted on purpose: a tap opens the app home rather than a room (see the
		// service worker's notificationclick handler).
		const ok = await sendPushNotification(userId, sub, {
			performanceId: 'test',
			artist: 'StageHopper test',
			stage: 'Notifications are working',
			startTime: ''
		});
		if (ok) sent++;
	}
	const failed = subscriptions.length - sent;
	return { ok: sent > 0, sent, failed, total: subscriptions.length };
}

// ---- Handler ----

export async function handler(event?: NotifierEvent): Promise<void | TestSendResult> {
	// Admin test path: an explicit invoke, not the EventBridge tick. Send immediately and
	// return the result to the caller instead of running the scheduled scan.
	if (event?.test) {
		if (!event.userId) {
			return { ok: false, sent: 0, failed: 0, total: 0, error: 'userId is required' };
		}
		return sendTestNotification(event.userId);
	}

	const nowMs = Date.now();

	// Model A reads fresh every tick: clear the warm-container caches so an admin's
	// festival/timetable edit is picked up on the next run, not only after a cold start.
	festivalsCache = null;
	timetablesCache.clear();
	// Same reason: a slug room gets its index row on the first pick saved in it, so a null
	// cached before that must not outlive the tick — otherwise a warm container keeps the
	// room excluded from notifications until it recycles.
	roomFestivalCache.clear();

	// Load festivals
	const festivals = await loadFestivals();
	if (festivals.length === 0) {
		console.log('No active festivals, exiting');
		return;
	}

	await initVapid();

	// For each active festival, build candidate performances. The zone is carried along with
	// them rather than looked up again per set, which is all the innermost loop wanted it for.
	const festivalCandidates: FestivalCandidates[] = [];
	for (const festival of festivals) {
		if (!isFestivalActive(festival)) continue;

		const performances = await loadTimetable(festival.id);
		const timezone = festival.timezone || 'Europe/Berlin';
		const candidates = getCandidatePerformances(performances, nowMs, timezone);

		if (candidates.length > 0) {
			festivalCandidates.push({ festivalId: festival.id, timezone, performances: candidates });
		}
	}

	if (festivalCandidates.length === 0) {
		console.log('No candidate performances, exiting');
		return;
	}

	const activeFestivalIds = new Set(festivalCandidates.map((entry) => entry.festivalId));

	// Scan the users table for notification-enabled users, a page at a time: the whole
	// table is never held in memory, and each user is handled as their page arrives.
	for await (const user of paginate<UserSettings>(
		ddb,
		(startKey) =>
			new ScanCommand({
				TableName: USERS_TABLE,
				FilterExpression: 'enabled = :true',
				ExpressionAttributeValues: { ':true': true },
				ExclusiveStartKey: startKey
			})
	)) {
		if (!user.userId) continue;

		const picks = await loadUserPicks(user.userId, user.rooms ?? {}, activeFestivalIds);
		if (picks.length === 0) continue;

		for (const item of dueNotifications(user, festivalCandidates, picks, nowMs)) {
			const perf = item.performance;

			// Try to write dedup
			const isNew = await tryWriteDedup(user.userId, perf.id, item.perfStartMs);
			if (!isNew) continue; // Already sent

			// Send push notifications. Roll back the dedup claim if every send failed
			// (e.g. a transient push-service error) so the next tick retries rather
			// than silently burning this notification forever.
			const subscriptions = await getUserSubscriptions(user.userId);
			let anySent = false;
			for (const sub of subscriptions) {
				const ok = await sendPushNotification(user.userId, sub, {
					performanceId: perf.id,
					roomId: item.roomId,
					artist: perf.artist,
					stage: perf.stage,
					startTime: perf.startTime
				});
				anySent = anySent || ok;
			}
			if (!anySent) {
				await deleteDedup(user.userId, perf.id);
			}
		}
	}

	console.log('Notifier cycle complete');
}
