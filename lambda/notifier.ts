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
import { performanceStartUtcMs, isDue, inCandidateWindow, aggregateStates, qualifies } from './schedule.js';
import { getSecret } from './secrets.js';

const dynamodb = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(dynamodb);
const s3 = new S3Client({});

const TABLE = process.env.TABLE_NAME || '';
const USERS_TABLE = process.env.USERS_TABLE || '';
const PUSH_SUBSCRIPTIONS_TABLE = process.env.PUSH_SUBSCRIPTIONS_TABLE || '';
const NOTIF_DEDUP_TABLE = process.env.NOTIF_DEDUP_TABLE || '';
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

interface FestivalRecord {
	id: string;
	name: string;
	timezone?: string;
	startDate: string;
	endDate: string;
}

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
	notifyAttending?: boolean;
	notifyMaybe?: boolean;
	leadMinutes?: number;
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
 * Load festivals.json from S3 (cached).
 */
async function loadFestivals(): Promise<FestivalRecord[]> {
	if (festivalsCache !== null) return festivalsCache;

	try {
		const result = await s3.send(
			new GetObjectCommand({
				Bucket: SITE_BUCKET,
				Key: 'data/festivals.json'
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
 * Load timetable for a festival from S3 (cached).
 */
async function loadTimetable(festivalId: string): Promise<Performance[]> {
	if (timetablesCache.has(festivalId)) {
		return timetablesCache.get(festivalId) || [];
	}

	try {
		const result = await s3.send(
			new GetObjectCommand({
				Bucket: SITE_BUCKET,
				Key: `data/timetable-${festivalId}.json`
			})
		);
		const text = await result.Body?.transformToString();
		const payload = JSON.parse(text || '{}');

		const performances: Performance[] = [];
		for (const day of payload.days || []) {
			for (const perf of day.performances || []) {
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
 * Determine if a festival is active today (in its timezone).
 */
function isFestivalActive(festival: FestivalRecord): boolean {
	const tz = festival.timezone || 'Europe/Berlin';
	const formatter = new Intl.DateTimeFormat('en-CA', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	});
	const parts = formatter.formatToParts(new Date());
	const field = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
	// Build YYYY-MM-DD from the named fields — joining every part (literals included)
	// would splice the format's own separators back in (e.g. "2026---07---18").
	const todayStr = `${field('year')}-${field('month')}-${field('day')}`;

	return todayStr >= festival.startDate && todayStr <= festival.endDate;
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
 * Get a user's selection state for a performance across all their rooms.
 * Returns array of states [0, 1, 2] from each room where they have a selection.
 */
async function getUserMarksForPerformance(
	userId: string,
	perfId: string,
	festivalId: string,
	userRooms: Record<string, { updatedAt?: number }>
): Promise<{ states: number[]; roomId: string | null }> {
	const states: number[] = [];
	// The notification's tap-through opens one room; pick the most-recently-updated room
	// among those where the user marked this set (see Q8 in the design).
	let bestRoomId: string | null = null;
	let bestUpdatedAt = -1;

	try {
		// The user's rooms come off their user row; keep only this festival's rooms.
		const rooms = Object.entries(userRooms).filter(([roomId]) =>
			roomId.startsWith(`${festivalId}-`)
		);

		for (const [roomId, meta] of rooms) {
			const selItem = await ddb.send(
				new GetCommand({
					TableName: TABLE,
					Key: { roomId, userId }
				})
			);

			const selections = (selItem.Item as any)?.selections || {};
			const state = selections[perfId];
			if (typeof state === 'number') {
				states.push(state);
				const updatedAt = Number(meta?.updatedAt ?? 0);
				if (updatedAt >= bestUpdatedAt) {
					bestUpdatedAt = updatedAt;
					bestRoomId = roomId;
				}
			}
		}
	} catch (err) {
		console.error(`Error getting states for user ${userId}:`, err);
	}

	return { states, roomId: bestRoomId };
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

	// Load festivals
	const festivals = await loadFestivals();
	if (festivals.length === 0) {
		console.log('No active festivals, exiting');
		return;
	}

	await initVapid();

	// For each active festival, build candidate performances
	const festivalPerformances = new Map<string, Performance[]>();
	for (const festival of festivals) {
		if (!isFestivalActive(festival)) continue;

		const performances = await loadTimetable(festival.id);
		const tz = festival.timezone || 'Europe/Berlin';
		const candidates = getCandidatePerformances(performances, nowMs, tz);

		if (candidates.length > 0) {
			festivalPerformances.set(festival.id, candidates);
		}
	}

	if (festivalPerformances.size === 0) {
		console.log('No candidate performances, exiting');
		return;
	}

	// Scan the users table for notification-enabled users
	let startKey: Record<string, unknown> | undefined;
	do {
		const result = await ddb.send(
			new ScanCommand({
				TableName: USERS_TABLE,
				FilterExpression: 'enabled = :true',
				ExpressionAttributeValues: { ':true': true },
				ExclusiveStartKey: startKey
			})
		);

		const users = (result.Items || []) as UserSettings[];
		for (const user of users) {
			if (!user.userId) continue;

			// Process each active festival
			for (const [festivalId, performances] of festivalPerformances) {
				// Defaults match the app: 15-minute lead, both categories off.
				const leadMins = user.leadMinutes ?? 15;

				for (const perf of performances) {
					// Get user's selection state
					const marks = await getUserMarksForPerformance(
						user.userId,
						perf.id,
						festivalId,
						user.rooms ?? {}
					);
					if (marks.states.length === 0) continue;

					const agg = aggregateStates(marks.states);
					if (!qualifies(agg, user.notifyAttending ?? false, user.notifyMaybe ?? false)) {
						continue;
					}

					const tz = festivals.find((f) => f.id === festivalId)?.timezone || 'Europe/Berlin';
					const perfStartMs = performanceStartUtcMs(perf.dayDate, perf.startTime, tz);
					const sendAtMs = perfStartMs - leadMins * 60_000;

					if (!isDue(sendAtMs, nowMs)) continue;

					// Try to write dedup
					const isNew = await tryWriteDedup(user.userId, perf.id, perfStartMs);
					if (!isNew) continue; // Already sent

					// Send push notifications. Roll back the dedup claim if every send failed
					// (e.g. a transient push-service error) so the next tick retries rather
					// than silently burning this notification forever.
					const subscriptions = await getUserSubscriptions(user.userId);
					let anySent = false;
					for (const sub of subscriptions) {
						const ok = await sendPushNotification(user.userId, sub, {
							performanceId: perf.id,
							roomId: marks.roomId ?? festivalId,
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
		}

		startKey = result.LastEvaluatedKey;
	} while (startKey);

	console.log('Notifier cycle complete');
}
