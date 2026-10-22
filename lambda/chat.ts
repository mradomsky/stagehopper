/**
 * @file Festival chat: Messages in `MESSAGES_TABLE`, and the Festival summary line.
 *
 * A Message is one row per post: `{ festivalId, messageId, userId, handle, colour, text,
 * createdAt }` (`handle` is the Nickname; the public shape also emits it as `nickname`). `handle` and `colour` are a snapshot of the poster at post time, not
 * refreshed afterwards (unlike Picks, ADR 0005). The public shape carries `userId` so a client
 * can recognise its own Messages (#251).
 *
 * The router owns the route switch, the Festival id check and the admin scope; it passes the
 * caller in. Everything below answers `{ ok } | { error }`, which the router maps to a status.
 *
 * Must not import `index.ts` (it is imported by it). Specs mock the shared `send`.
 */

import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
	DynamoDBDocumentClient,
	DeleteCommand,
	GetCommand,
	PutCommand,
	QueryCommand,
	UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import { collect, paginate } from '../shared/dynamo-paginate.js';
import { resolveAttendee, type AttendeeIdentity } from './attendee.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const MESSAGES_TABLE = process.env.MESSAGES_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;
const PICKS_TABLE = process.env.PICKS_TABLE;
const FESTIVALS_TABLE = process.env.FESTIVALS_TABLE;

const MAX_TEXT_LENGTH = 500;
/** Most Messages one GET returns, whichever direction it pages. */
const PAGE_SIZE = 200;
/** Minimum gap between two posts by one user. */
const POST_INTERVAL_MS = 2000;
/** A Message id, or the bare 13-digit millisecond prefix of one (a polling cursor). */
const CURSOR_REGEX = /^\d{13}(-[0-9a-z]{8})?$/;
const MESSAGE_ID_REGEX = /^\d{13}-[0-9a-z]{8}$/;

export interface Message {
	messageId: string;
	userId: string;
	nickname: string;
	/** Same value as `nickname`; dropped with #254. */
	handle: string;
	colour: string;
	text: string;
	createdAt: number;
}

export interface ChatError {
	status: 400 | 403 | 429;
	message: string;
}

export type ChatResult<T> = { ok: T } | { error: ChatError };

const fail = (status: ChatError['status'], message: string): { error: ChatError } => ({
	error: { status, message }
});

function isConditionFailure(err: unknown): boolean {
	return (err as { name?: string })?.name === 'ConditionalCheckFailedException';
}

/** The public shape of a stored row. */
function toMessage(row: Record<string, unknown>): Message {
	return {
		messageId: row.messageId as string,
		userId: row.userId as string,
		nickname: row.handle as string,
		handle: row.handle as string,
		colour: row.colour as string,
		text: row.text as string,
		createdAt: row.createdAt as number
	};
}

let lastTimestamp = 0;

/**
 * `<13-digit zero-padded ms>-<8 random [0-9a-z]>`. Ids sort by time as strings. Within one
 * Lambda instance the timestamp part is strictly increasing, so same-millisecond posts keep
 * post order; across instances the random suffix only breaks ties.
 *
 * shortcut: ids from different instances in one millisecond sort randomly; use a shared
 * sequence only if chat order within a millisecond ever matters.
 */
function mintMessageId(now: number): string {
	const timestamp = Math.max(now, lastTimestamp + 1);
	lastTimestamp = timestamp;
	const suffix = Array.from(randomBytes(8), (b) => (b % 36).toString(36)).join('');
	return `${String(timestamp).padStart(13, '0')}-${suffix}`;
}

/**
 * Messages of a Festival, oldest first in the response. No cursor: the newest 200. `before`:
 * the newest 200 older than it. `after`: up to 200 newer than it, oldest first, so a client
 * re-polls while a full page comes back (and one response stays under the 6 MB limit).
 * An empty cursor counts as absent.
 */
export async function listMessages(
	festivalId: string,
	{ after, before }: { after?: string; before?: string }
): Promise<ChatResult<Message[]>> {
	after ||= undefined;
	before ||= undefined;
	if (after && before) return fail(400, 'use either after or before, not both');
	for (const cursor of [after, before]) {
		if (cursor !== undefined && !CURSOR_REGEX.test(cursor)) return fail(400, 'Invalid cursor');
	}

	const ascending = after !== undefined;
	const result = await ddb.send(
		new QueryCommand({
			TableName: MESSAGES_TABLE,
			KeyConditionExpression: after
				? 'festivalId = :f AND messageId > :a'
				: before
					? 'festivalId = :f AND messageId < :b'
					: 'festivalId = :f',
			ExpressionAttributeValues: {
				':f': festivalId,
				...(after && { ':a': after }),
				...(before && { ':b': before })
			},
			ScanIndexForward: ascending,
			Limit: PAGE_SIZE
		})
	);
	const rows = result.Items ?? [];
	if (!ascending) rows.reverse();
	return { ok: rows.map(toMessage) };
}

/**
 * Post a Message as the caller. Checks, in order: text, the Festival exists, the
 * Attendee is not banned and has a Nickname and a colour, then the 2 s rate limit. The ban is checked
 * before the colour so a banned user sees the ban, and before the rate limit so a banned
 * user never writes `lastPostedAt`.
 */
export async function postMessage(
	identity: AttendeeIdentity,
	festivalId: string,
	text: unknown
): Promise<ChatResult<Message>> {
	const trimmed = typeof text === 'string' ? text.trim() : '';
	if (trimmed.length === 0 || trimmed.length > MAX_TEXT_LENGTH) {
		return fail(400, `text must be 1 to ${MAX_TEXT_LENGTH} characters`);
	}

	const festival = await ddb.send(
		new GetCommand({ TableName: FESTIVALS_TABLE, Key: { id: festivalId } })
	);
	if (!festival.Item) return fail(400, 'Unknown festival');

	const resolved = await resolveAttendee(identity);
	if ('error' in resolved) return fail(resolved.error.status, resolved.error.message);
	const { attendee } = resolved;
	if (attendee.banned) return fail(403, 'You cannot post in chat');
	if (!attendee.nickname) return fail(400, 'nickname is required');
	if (!attendee.colour) return fail(400, 'choose a colour first');

	const now = Date.now();
	try {
		await ddb.send(
			new UpdateCommand({
				TableName: USERS_TABLE,
				Key: { userId: attendee.userId },
				UpdateExpression: 'SET lastPostedAt = :now',
				ConditionExpression: 'attribute_not_exists(lastPostedAt) OR lastPostedAt <= :cutoff',
				ExpressionAttributeValues: { ':now': now, ':cutoff': now - POST_INTERVAL_MS }
			})
		);
	} catch (err) {
		if (isConditionFailure(err)) return fail(429, 'You are posting too fast');
		throw err;
	}

	const row = {
		festivalId,
		messageId: mintMessageId(now),
		userId: attendee.userId,
		handle: attendee.nickname,
		colour: attendee.colour,
		text: trimmed,
		createdAt: now
	};
	await ddb.send(new PutCommand({ TableName: MESSAGES_TABLE, Item: row }));
	return { ok: toMessage(row) };
}

/**
 * Delete a Message. An Admin deletes any; anyone else only their own, in one conditional
 * write. A refused delete of an existing Message is 403; an id that does not exist is
 * success, so a retried delete succeeds (and a 404 would reach the client as HTML, #181).
 */
export async function deleteMessage(
	identity: AttendeeIdentity,
	festivalId: string,
	messageId: string,
	asAdmin: boolean
): Promise<ChatResult<true>> {
	if (!MESSAGE_ID_REGEX.test(messageId)) {
		return fail(400, 'Invalid message id');
	}
	try {
		await ddb.send(
			new DeleteCommand({
				TableName: MESSAGES_TABLE,
				Key: { festivalId, messageId },
				...(!asAdmin && {
					ConditionExpression: 'userId = :me',
					ExpressionAttributeValues: { ':me': identity.participantKey },
					ReturnValuesOnConditionCheckFailure: 'ALL_OLD'
				})
			})
		);
	} catch (err) {
		if (!isConditionFailure(err)) throw err;
		// `Item` is present only when the row exists, so only then is it someone else's.
		if ((err as { Item?: unknown }).Item) return fail(403, 'You can only delete your own messages');
	}
	return { ok: true };
}

/**
 * The key of every Message a user posted, across Festivals, for the user-delete cascade.
 * Rows missing either key are dropped (as `listPicksFestivalIds` does for Picks).
 *
 * shortcut: the `userId-index` GSI is eventually consistent, so a Message posted seconds
 * before the delete can survive; ban first, then delete.
 */
export async function listMessageKeysOf(
	userId: string
): Promise<{ festivalId: string; messageId: string }[]> {
	const rows = await collect(
		paginate<{ festivalId?: string; messageId?: string }>(
			ddb,
			(startKey) =>
				new QueryCommand({
					TableName: MESSAGES_TABLE,
					IndexName: 'userId-index',
					KeyConditionExpression: 'userId = :u',
					ExpressionAttributeValues: { ':u': userId },
					ExclusiveStartKey: startKey
				})
		)
	);
	return rows.flatMap((r) =>
		r.festivalId && r.messageId ? [{ festivalId: r.festivalId, messageId: r.messageId }] : []
	);
}

async function userIdsOf(table: string | undefined, festivalId: string): Promise<string[]> {
	const rows = await collect(
		paginate<{ userId?: string }>(
			ddb,
			(startKey) =>
				new QueryCommand({
					TableName: table,
					KeyConditionExpression: 'festivalId = :f',
					ExpressionAttributeValues: { ':f': festivalId },
					ProjectionExpression: 'userId',
					ExclusiveStartKey: startKey
				})
		)
	);
	return rows.map((r) => r.userId).filter((id): id is string => !!id);
}

/**
 * The Festival's headline numbers: distinct users with Picks or a Message, and the newest
 * Message.
 *
 * shortcut: reads every Picks and Message key per call, O(Picks + Messages); add a counter
 * on the Festival row when one passes about 10k Messages.
 */
export async function festivalSummary(
	festivalId: string
): Promise<{ attendees: number; latestMessage: Message | null }> {
	const [pickers, posters, latest] = await Promise.all([
		userIdsOf(PICKS_TABLE, festivalId),
		userIdsOf(MESSAGES_TABLE, festivalId),
		ddb.send(
			new QueryCommand({
				TableName: MESSAGES_TABLE,
				KeyConditionExpression: 'festivalId = :f',
				ExpressionAttributeValues: { ':f': festivalId },
				ScanIndexForward: false,
				Limit: 1
			})
		)
	]);
	const row = latest.Items?.[0];
	return {
		attendees: new Set([...pickers, ...posters]).size,
		latestMessage: row ? toMessage(row) : null
	};
}
