/**
 * @file The Attendee: a signed-in user as the Festival Space knows them.
 *
 * An Attendee is the user row's Nickname and `colour` (both chosen by the user, colour from the
 * shared palette). The Nickname is stored in the attribute `handle` (prod rows, no migration);
 * this module maps it to `nickname`. The Clerk `username` claim only seeds it, once, and only
 * when it passes {@link normalizeNickname}; resolving never overwrites a stored Nickname and
 * never refreshes Picks. Picks rows in `PICKS_TABLE` carry a denormalised copy of both so the
 * public read is one Query; when {@link updateProfile} changes either, the copies are refreshed
 * through the `userId-index` GSI.
 *
 * Ban checks and rate limits are deliberately not here: the routes that need them (chat)
 * read `attendee.banned` and write their own counters.
 *
 * Must not import `index.ts` (it is imported by it). Specs mock the shared `send`.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { isPaletteColour } from '../shared/colours.js';
import { collect, paginate } from '../shared/dynamo-paginate.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const USERS_TABLE = process.env.USERS_TABLE;
/** One row per (Festival, user): `{ handle, colour, selections, updatedAt }`. GSI `userId-index` is KEYS_ONLY. */
const PICKS_TABLE = process.env.PICKS_TABLE;

/** The slice of the caller {@link resolveAttendee} reads; the router's `Identity` satisfies it. */
export interface AttendeeIdentity {
	participantKey: string;
	/** The token's `username` claim: seeds the Nickname when none is stored. */
	usernameSeed: string;
	name: string;
	email: string;
}

export interface Attendee {
	userId: string;
	/** Empty when the user has none yet and no valid seed. */
	nickname: string;
	colour: string | null;
	banned: boolean;
}

/** A rejection the router turns into a 4xx response. */
export interface AttendeeError {
	status: 400;
	message: string;
}

export type AttendeeResult = { attendee: Attendee } | { error: AttendeeError };

const NICKNAME_REGEX = /^[A-Za-z0-9_-]{2,20}$/;

/** The trimmed Nickname when it is 2 to 20 of letters, digits, `_` or `-`; otherwise null. Not unique. */
export function normalizeNickname(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return NICKNAME_REGEX.test(trimmed) ? trimmed : null;
}

function isConditionFailure(err: unknown): boolean {
	return (err as { name?: string })?.name === 'ConditionalCheckFailedException';
}

/** Festival ids this user has a Picks row in. */
export async function listPicksFestivalIds(userId: string): Promise<string[]> {
	const rows = await collect(
		paginate<{ festivalId?: string }>(
			ddb,
			(startKey) =>
				new QueryCommand({
					TableName: PICKS_TABLE,
					IndexName: 'userId-index',
					KeyConditionExpression: 'userId = :u',
					ExpressionAttributeValues: { ':u': userId },
					ExclusiveStartKey: startKey
				})
		)
	);
	return rows.map((r) => r.festivalId).filter((id): id is string => !!id);
}

/**
 * Copy a changed Nickname or colour onto every Picks row of the user. Best effort: a row that
 * vanished meanwhile is skipped, and any other failure is logged, not thrown, because the
 * user row already holds the truth and the Picks row heals on its next save.
 *
 * shortcut: two concurrent changes can leave a Picks row on the older value, until its next
 * save; add a version attribute on the user row if that ever shows up.
 */
async function refreshPicksRows(userId: string, nickname: string, colour: string): Promise<void> {
	try {
		const festivalIds = await listPicksFestivalIds(userId);
		await Promise.all(
			festivalIds.map(async (festivalId) => {
				try {
					await ddb.send(
						new UpdateCommand({
							TableName: PICKS_TABLE,
							Key: { festivalId, userId },
							UpdateExpression: 'SET handle = :h, colour = :c',
							ConditionExpression: 'attribute_exists(userId)',
							ExpressionAttributeValues: { ':h': nickname, ':c': colour }
						})
					);
				} catch (err) {
					if (!isConditionFailure(err)) console.error('Failed to refresh Picks row:', err);
				}
			})
		);
	} catch (err) {
		console.error('Failed to refresh Picks rows:', err);
	}
}

/**
 * Touch the caller's user row (name, email, lastActive) and return them as an Attendee. One
 * write, new values back. A valid `username` claim becomes the Nickname only if none is stored.
 * Picks rows are never refreshed here. With `requireColour`, a user who has not chosen a
 * colour is refused (400) and nothing is written.
 */
export async function resolveAttendee(
	identity: AttendeeIdentity,
	{ requireColour = false }: { requireColour?: boolean } = {}
): Promise<AttendeeResult> {
	const seed = normalizeNickname(identity.usernameSeed);
	let row: Record<string, unknown> | undefined;
	try {
		const result = await ddb.send(
			new UpdateCommand({
				TableName: USERS_TABLE,
				Key: { userId: identity.participantKey },
				UpdateExpression:
					'SET #name = :n, email = :e, lastActive = :now' +
					(seed ? ', handle = if_not_exists(handle, :seed)' : ''),
				...(requireColour && { ConditionExpression: 'attribute_exists(colour)' }),
				ExpressionAttributeNames: { '#name': 'name' },
				ExpressionAttributeValues: {
					':n': identity.name,
					':e': identity.email,
					':now': Date.now(),
					...(seed && { ':seed': seed })
				},
				ReturnValues: 'ALL_NEW'
			})
		);
		row = result.Attributes;
	} catch (err) {
		if (isConditionFailure(err)) {
			return { error: { status: 400, message: 'choose a colour first' } };
		}
		throw err;
	}

	return {
		attendee: {
			userId: identity.participantKey,
			nickname: typeof row?.handle === 'string' ? row.handle : '',
			colour: typeof row?.colour === 'string' ? row.colour : null,
			banned: row?.banned === true
		}
	};
}

/**
 * Update the caller's Nickname and/or colour in one write. Both are validated before anything
 * is written (400, nothing written); neither given is 400 too. The name is never read from
 * the token here, so a rename survives a colour-only update. Picks copies are refreshed only
 * when a given value differs from the stored one.
 */
export async function updateProfile(
	identity: AttendeeIdentity,
	input: { nickname?: unknown; colour?: unknown }
): Promise<AttendeeResult> {
	const hasNickname = input.nickname !== undefined;
	const hasColour = input.colour !== undefined;
	if (!hasNickname && !hasColour) {
		return { error: { status: 400, message: 'nickname or colour is required' } };
	}
	const nickname = hasNickname ? normalizeNickname(input.nickname) : null;
	if (hasNickname && !nickname) {
		return {
			error: { status: 400, message: 'nickname must be 2 to 20 characters: letters, digits, _ or -' }
		};
	}
	if (hasColour && !isPaletteColour(input.colour)) {
		return { error: { status: 400, message: 'colour must be one of the palette colours' } };
	}
	const colour = hasColour ? (input.colour as string).toLowerCase() : null;
	const seed = hasNickname ? null : normalizeNickname(identity.usernameSeed);

	const sets = ['#name = :n', 'email = :e', 'lastActive = :now'];
	const values: Record<string, unknown> = {
		':n': identity.name,
		':e': identity.email,
		':now': Date.now()
	};
	if (nickname) {
		sets.push('handle = :h');
		values[':h'] = nickname;
	} else if (seed) {
		sets.push('handle = if_not_exists(handle, :seed)');
		values[':seed'] = seed;
	}
	if (colour) {
		sets.push('colour = :c');
		values[':c'] = colour;
	}

	const result = await ddb.send(
		new UpdateCommand({
			TableName: USERS_TABLE,
			Key: { userId: identity.participantKey },
			UpdateExpression: 'SET ' + sets.join(', '),
			ExpressionAttributeNames: { '#name': 'name' },
			ExpressionAttributeValues: values,
			ReturnValues: 'ALL_OLD'
		})
	);
	const old = result.Attributes;
	const oldNickname = typeof old?.handle === 'string' ? old.handle : '';
	const finalNickname = nickname ?? (oldNickname || seed || '');
	const finalColour = colour ?? (typeof old?.colour === 'string' ? old.colour : null);
	const changed =
		(nickname !== null && nickname !== oldNickname) || (colour !== null && colour !== old?.colour);
	if (changed && finalNickname && finalColour) {
		await refreshPicksRows(identity.participantKey, finalNickname, finalColour);
	}
	return {
		attendee: {
			userId: identity.participantKey,
			nickname: finalNickname,
			colour: finalColour,
			banned: old?.banned === true
		}
	};
}
