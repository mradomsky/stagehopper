/**
 * @file The Attendee: a signed-in user as the Festival Space knows them.
 *
 * An Attendee is the user row's `handle` (read-only, from the Clerk `username` claim) and
 * `colour` (chosen once, from the shared palette). Picks rows in `PICKS_TABLE` carry a
 * denormalised copy of both so the public read is one Query; when either changes here, the
 * copies are refreshed through the `userId-index` GSI.
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
	handle: string;
	name: string;
	email: string;
}

export interface Attendee {
	userId: string;
	handle: string;
	colour: string | null;
	banned: boolean;
}

/** A rejection the router turns into a 4xx response. */
export interface AttendeeError {
	status: 400;
	message: string;
}

export type AttendeeResult = { attendee: Attendee } | { error: AttendeeError };

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
 * Copy a changed handle or colour onto every Picks row of the user. Best effort: a row that
 * vanished meanwhile is skipped, and any other failure is logged, not thrown, because the
 * user row already holds the truth and the Picks row heals on its next save.
 *
 * shortcut: two concurrent changes can leave a Picks row on the older value, until its next
 * save; add a version attribute on the user row if that ever shows up.
 */
async function refreshPicksRows(userId: string, handle: string, colour: string): Promise<void> {
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
							ExpressionAttributeValues: { ':h': handle, ':c': colour }
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
 * Refresh the caller's user row from the token and return them as an Attendee. One write,
 * old values back. With `requireColour`, a user who has not chosen a colour is refused
 * (400) and nothing is written.
 */
export async function resolveAttendee(
	identity: AttendeeIdentity,
	{ requireColour = false }: { requireColour?: boolean } = {}
): Promise<AttendeeResult> {
	let old: Record<string, unknown> | undefined;
	try {
		const result = await ddb.send(
			new UpdateCommand({
				TableName: USERS_TABLE,
				Key: { userId: identity.participantKey },
				UpdateExpression: 'SET handle = :h, #name = :n, email = :e, lastActive = :now',
				...(requireColour && { ConditionExpression: 'attribute_exists(colour)' }),
				ExpressionAttributeNames: { '#name': 'name' },
				ExpressionAttributeValues: {
					':h': identity.handle,
					':n': identity.name,
					':e': identity.email,
					':now': Date.now()
				},
				ReturnValues: 'ALL_OLD'
			})
		);
		old = result.Attributes;
	} catch (err) {
		if (isConditionFailure(err)) {
			return { error: { status: 400, message: 'choose a colour first' } };
		}
		throw err;
	}

	const colour = typeof old?.colour === 'string' ? old.colour : null;
	if (colour && old?.handle !== identity.handle) {
		await refreshPicksRows(identity.participantKey, identity.handle, colour);
	}
	return {
		attendee: {
			userId: identity.participantKey,
			handle: identity.handle,
			colour,
			banned: old?.banned === true
		}
	};
}

/** Store the caller's colour (canonical lowercase) after checking it against the palette. */
export async function setAttendeeColour(
	identity: AttendeeIdentity,
	colour: unknown
): Promise<AttendeeResult> {
	if (!isPaletteColour(colour)) {
		return { error: { status: 400, message: 'colour must be one of the palette colours' } };
	}
	const canonical = colour.toLowerCase();

	const result = await ddb.send(
		new UpdateCommand({
			TableName: USERS_TABLE,
			Key: { userId: identity.participantKey },
			UpdateExpression:
				'SET colour = :c, handle = :h, #name = :n, email = :e, lastActive = :now',
			ExpressionAttributeNames: { '#name': 'name' },
			ExpressionAttributeValues: {
				':c': canonical,
				':h': identity.handle,
				':n': identity.name,
				':e': identity.email,
				':now': Date.now()
			},
			ReturnValues: 'ALL_OLD'
		})
	);
	const old = result.Attributes;
	if (old?.colour !== canonical || old?.handle !== identity.handle) {
		await refreshPicksRows(identity.participantKey, identity.handle, canonical);
	}
	return {
		attendee: {
			userId: identity.participantKey,
			handle: identity.handle,
			colour: canonical,
			banned: old?.banned === true
		}
	};
}
