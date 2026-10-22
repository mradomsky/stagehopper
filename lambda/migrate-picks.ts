/**
 * @file One-shot, idempotent migration of Room selections into Festival Picks (#206).
 *
 * Run by an operator from `migrate-picks-cli.ts`, never by the API Lambda (it needs the
 * Clerk secret key and must not be reachable from a route). Two entry points:
 *
 * - {@link mergePicks}: pure. Rows in, Picks rows + user-row updates + a report out.
 * - {@link migratePicks}: reads the tables, calls `mergePicks`, writes (unless `dryRun`).
 *
 * Idempotent because nothing here reads the clock: a Picks row's `updatedAt` is the newest
 * contributing Room's `updatedAt`, so a second run produces byte-identical rows.
 *
 * Must not import `index.ts`, and is not bundled into either Lambda.
 */

import { PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { isPaletteColour, PARTICIPANT_COLORS } from '../shared/colours.js';
import { collect, paginate } from '../shared/dynamo-paginate.js';

// shortcut: inlined from the retired shared/room-ids so this script outlives it; delete the script with the old Room tables.
/** A festival-prefixed Room id (festival id, hyphen, six hex digits), with the festival id captured. */
const FESTIVAL_ROOM_ID_REGEX = /^([a-z0-9]{2,10})-[0-9a-f]{6}$/;
/** Reserved userId of the row holding a Room's display name; not a participant. */
const ROOM_NAME_USER_ID = '@room';
function festivalIdFromRoomId(roomId: string): string | null {
	return FESTIVAL_ROOM_ID_REGEX.exec(roomId)?.[1] ?? null;
}

type State = 0 | 1 | 2;

/** One row of the Room selections table (`TABLE_NAME`, PK roomId, SK userId). */
export interface SelectionRow {
	roomId: string;
	userId: string;
	name?: string;
	color?: string;
	selections: Record<string, State>;
}

/** The parts of a `users` row the migration reads. `rooms` carries the only recency there is. */
export interface UserRow {
	userId: string;
	handle?: string;
	colour?: string;
	rooms?: Record<string, { updatedAt?: number }>;
}

/** A row of `PICKS_TABLE`. */
export interface PicksRow {
	festivalId: string;
	userId: string;
	handle: string;
	colour: string;
	selections: Record<string, State>;
	updatedAt: number;
}

export interface UserUpdate {
	userId: string;
	handle: string;
	colour: string;
}

export interface MergeInput {
	selectionRows: SelectionRow[];
	users: UserRow[];
	/** roomId → festivalId from the rooms table, for custom-slug Rooms. */
	roomFestivals: Record<string, string>;
	festivalIds: string[];
	/** Performance ids per Festival. */
	performanceIds: Record<string, string[]>;
	/** Users Clerk knows, by `clerk:` user id. Absent = the account no longer exists. */
	clerkUsers: Record<string, { username: string | null }>;
	/** Rows already in the Picks table, to predict `skippedNewer` and spot live saves. */
	existingPicks?: PicksRow[];
}

export interface MigrationReport {
	/** Users that get a Picks row and a user-row update. */
	users: number;
	festivals: number;
	/** Picks rows to put: the same number on every run. */
	rowsWritten: number;
	roomsDropped: number;
	droppedRoomIds: string[];
	legacyKeys: number;
	stalePerformances: number;
	noRecency: number;
	noUserRow: string[];
	notInClerk: string[];
	noHandle: string[];
	coloursDefaulted: string[];
	/** Existing Picks rows strictly newer than the migrated one: left alone. */
	skippedNewer: number;
	/** Existing Picks rows this migration would not produce: a sign of live saves. */
	unexpectedRows: number;
}

export interface MergeResult {
	/** Rows to put, sorted by festivalId then userId. */
	picks: PicksRow[];
	userUpdates: UserUpdate[];
	report: MigrationReport;
}

const CLERK_PREFIX = /^clerk:/;

/** going (1) beats maybe (2). */
function stronger(a: State | undefined, b: State): State {
	if (!a) return b;
	return a === 1 || b === 1 ? 1 : 2;
}

interface UserRoom {
	roomId: string;
	row: SelectionRow;
	updatedAt: number;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Newest first, ties by roomId ascending, so the order never depends on scan order. */
function byRecency(a: UserRoom, b: UserRoom): number {
	return b.updatedAt - a.updatedAt || compare(a.roomId, b.roomId);
}

const sortedUnique = (ids: Iterable<string>) => [...new Set(ids)].sort(compare);

/** Sorted keys, so the stored item serialises the same way on every run. */
function sortedSelections(map: Record<string, State>): Record<string, State> {
	return Object.fromEntries(Object.entries(map).sort(([a], [b]) => compare(a, b)));
}

const picksKey = (p: { festivalId: string; userId: string }) => `${p.festivalId}\u0000${p.userId}`;

export function mergePicks(input: MergeInput): MergeResult {
	const festivals = new Set(input.festivalIds);
	const performances = new Map(
		Object.entries(input.performanceIds).map(([id, ids]) => [id, new Set(ids)])
	);
	const usersById = new Map(input.users.map((u) => [u.userId, u]));

	const rows = input.selectionRows.filter((r) => r.userId !== ROOM_NAME_USER_ID);
	const report: MigrationReport = {
		users: 0,
		festivals: 0,
		rowsWritten: 0,
		roomsDropped: 0,
		droppedRoomIds: [],
		legacyKeys: 0,
		stalePerformances: 0,
		noRecency: 0,
		noUserRow: [],
		notInClerk: [],
		noHandle: [],
		coloursDefaulted: [],
		skippedNewer: 0,
		unexpectedRows: 0
	};

	const festivalOf = (roomId: string): string | null => {
		const id = festivalIdFromRoomId(roomId) ?? input.roomFestivals[roomId] ?? null;
		return id && festivals.has(id) ? id : null;
	};

	const dropped = new Set<string>();
	for (const r of rows) if (!festivalOf(r.roomId)) dropped.add(r.roomId);
	report.droppedRoomIds = sortedUnique(dropped);
	report.roomsDropped = dropped.size;

	const rowsByUser = new Map<string, SelectionRow[]>();
	for (const r of rows) {
		if (!CLERK_PREFIX.test(r.userId)) {
			report.legacyKeys++;
			continue;
		}
		rowsByUser.set(r.userId, [...(rowsByUser.get(r.userId) ?? []), r]);
	}

	const picks: PicksRow[] = [];
	const userUpdates: UserUpdate[] = [];
	const noUserRow: string[] = [];
	const notInClerk: string[] = [];
	const noHandle: string[] = [];
	const coloursDefaulted: string[] = [];

	for (const [userId, userRows] of rowsByUser) {
		const user = usersById.get(userId);
		if (!user) {
			noUserRow.push(userId);
			continue;
		}
		const clerk = input.clerkUsers[userId];
		if (!clerk) {
			notInClerk.push(userId);
			continue;
		}

		const rooms: UserRoom[] = userRows.map((row) => {
			const updatedAt = user.rooms?.[row.roomId]?.updatedAt;
			if (typeof updatedAt !== 'number') report.noRecency++;
			return { roomId: row.roomId, row, updatedAt: updatedAt ?? 0 };
		});
		rooms.sort(byRecency);

		const handle =
			user.handle || clerk.username || rooms.map((r) => r.row.name).find((n) => !!n) || '';
		if (!handle) {
			noHandle.push(userId);
			continue;
		}

		// Derived from the Room data, not from the users row alone: run 1 writes the default
		// onto the users row, and run 2 must still list the same users.
		const roomColour = rooms.map((r) => r.row.color).find((c) => isPaletteColour(c))?.toLowerCase();
		const colour = user.colour || roomColour || PARTICIPANT_COLORS[0];
		const usedDefault = !roomColour && colour.toLowerCase() === PARTICIPANT_COLORS[0];
		if (usedDefault) coloursDefaulted.push(userId);

		const perFestival = new Map<string, { map: Record<string, State>; updatedAt: number }>();
		for (const room of rooms) {
			const festivalId = festivalOf(room.roomId);
			if (!festivalId) continue;
			const known = performances.get(festivalId);
			let contributed = false;
			const entry = perFestival.get(festivalId) ?? { map: {}, updatedAt: 0 };
			for (const [performanceId, state] of Object.entries(room.row.selections ?? {})) {
				if (!known?.has(performanceId)) {
					report.stalePerformances++;
					continue;
				}
				if (state !== 1 && state !== 2) continue;
				entry.map[performanceId] = stronger(entry.map[performanceId], state);
				contributed = true;
			}
			if (contributed) {
				entry.updatedAt = Math.max(entry.updatedAt, room.updatedAt);
				perFestival.set(festivalId, entry);
			}
		}
		if (perFestival.size === 0) continue;

		for (const [festivalId, { map, updatedAt }] of perFestival) {
			picks.push({ festivalId, userId, handle, colour, selections: sortedSelections(map), updatedAt });
		}
		userUpdates.push({ userId, handle, colour });
	}

	report.noUserRow = sortedUnique(noUserRow);
	report.notInClerk = sortedUnique(notInClerk);
	report.noHandle = sortedUnique(noHandle);
	report.coloursDefaulted = sortedUnique(coloursDefaulted);

	picks.sort((a, b) => compare(a.festivalId, b.festivalId) || compare(a.userId, b.userId));
	userUpdates.sort((a, b) => compare(a.userId, b.userId));

	const produced = new Map(picks.map((p) => [picksKey(p), p]));
	const newer = new Set<string>();
	for (const existing of input.existingPicks ?? []) {
		const mine = produced.get(picksKey(existing));
		if (!mine) report.unexpectedRows++;
		else if (existing.updatedAt > mine.updatedAt) newer.add(picksKey(existing));
	}
	report.skippedNewer = newer.size;
	const toWrite = picks.filter((p) => !newer.has(picksKey(p)));

	report.users = userUpdates.length;
	report.festivals = new Set(picks.map((p) => p.festivalId)).size;
	report.rowsWritten = toWrite.length;
	return { picks: toWrite, userUpdates, report };
}

/** Table names, passed in so the runner never reads the environment itself. */
export interface MigrationTables {
	selections: string;
	users: string;
	rooms: string;
	festivals: string;
	performances: string;
	picks: string;
}

export type ClerkUsers = Record<string, { username: string | null }>;

export interface MigrateOptions {
	send: (command: any) => Promise<any>;
	/** Resolve `clerk:` user ids to Clerk users; ids Clerk does not know are absent from the answer. */
	fetchClerkUsers: (userIds: string[]) => Promise<ClerkUsers>;
	tables: MigrationTables;
	dryRun: boolean;
	log?: (line: string) => void;
}

/** The counts an operator compares between the dry run and the real runs. */
export function formatReport(r: MigrationReport): string[] {
	const ids = (label: string, list: string[]) => `${label}: ${list.length}${list.length ? ` (${list.join(', ')})` : ''}`;
	return [
		`users: ${r.users}`,
		`festivals: ${r.festivals}`,
		`rows written: ${r.rowsWritten}`,
		ids('rooms dropped', r.droppedRoomIds),
		`legacy keys skipped: ${r.legacyKeys}`,
		`stale performances dropped: ${r.stalePerformances}`,
		`rooms without recency: ${r.noRecency}`,
		ids('no users row', r.noUserRow),
		ids('not in Clerk', r.notInClerk),
		ids('no handle', r.noHandle),
		ids('colours defaulted', r.coloursDefaulted),
		`skipped, newer row exists: ${r.skippedNewer}`,
		`unexpected rows in picks table: ${r.unexpectedRows}`
	];
}

const isConditionFailure = (err: unknown) =>
	(err as { name?: string })?.name === 'ConditionalCheckFailedException';

/**
 * Read all six tables, merge, and (unless `dryRun`) write the users rows then the Picks rows.
 *
 * Order matters for safety: every read and the Clerk lookup finish before the first write, so
 * a Clerk failure or the live-save guard leaves the tables untouched.
 */
export async function migratePicks(options: MigrateOptions): Promise<MigrationReport> {
	const { send, tables, dryRun } = options;
	const log = options.log ?? console.log;

	const scan = <T>(TableName: string, extra: object = {}) =>
		collect(
			paginate<T>(
				{ send },
				(ExclusiveStartKey) => new ScanCommand({ TableName, ConsistentRead: true, ExclusiveStartKey, ...extra })
			)
		);

	const [selectionRows, users, roomRows, festivalRows, performanceRows, existingPicks] = await Promise.all([
		scan<SelectionRow>(tables.selections),
		scan<UserRow>(tables.users),
		scan<{ roomId: string; festivalId?: string }>(tables.rooms),
		scan<{ id: string }>(tables.festivals),
		scan<{ festivalId: string; id: string }>(tables.performances),
		scan<PicksRow>(tables.picks)
	]);

	const withUserRow = new Set(users.map((u) => u.userId));
	const clerkIds = sortedUnique(
		selectionRows.map((r) => r.userId).filter((id) => CLERK_PREFIX.test(id) && withUserRow.has(id))
	);
	const clerkUsers = await options.fetchClerkUsers(clerkIds);

	const performanceIds: Record<string, string[]> = {};
	for (const p of performanceRows) (performanceIds[p.festivalId] ??= []).push(p.id);

	const { picks, userUpdates, report } = mergePicks({
		selectionRows,
		users,
		roomFestivals: Object.fromEntries(
			roomRows.filter((r) => r.festivalId).map((r) => [r.roomId, r.festivalId as string])
		),
		festivalIds: festivalRows.map((f) => f.id),
		performanceIds,
		clerkUsers,
		existingPicks
	});

	if (!dryRun && (report.skippedNewer > 0 || report.unexpectedRows > 0)) {
		throw new Error(
			'Refusing to run: the Picks table holds rows saved since the migration ' +
				`(${report.skippedNewer} newer, ${report.unexpectedRows} not produced by it). ` +
				'A rerun could resurrect Picks users have cleared. Run with --dry-run to inspect.'
		);
	}

	if (dryRun) {
		formatReport(report).forEach(log);
		return report;
	}

	// ADR 0005: Picks rows copy the users row, so write the users row first and copy what it holds.
	const copies = new Map<string, { handle: string; colour: string }>();
	for (const u of userUpdates) {
		try {
			const result = await send(
				new UpdateCommand({
					TableName: tables.users,
					Key: { userId: u.userId },
					UpdateExpression: 'SET handle = if_not_exists(handle, :h), colour = if_not_exists(colour, :c)',
					ConditionExpression: 'attribute_exists(userId)',
					ExpressionAttributeValues: { ':h': u.handle, ':c': u.colour },
					ReturnValues: 'ALL_NEW'
				})
			);
			copies.set(u.userId, { handle: result.Attributes.handle, colour: result.Attributes.colour });
		} catch (err) {
			if (!isConditionFailure(err)) throw err;
			// Deleted since the scan: no row to hang Picks on.
			report.noUserRow = sortedUnique([...report.noUserRow, u.userId]);
		}
	}

	report.rowsWritten = 0;
	for (const pick of picks) {
		const copy = copies.get(pick.userId);
		if (!copy) continue;
		try {
			await send(
				new PutCommand({
					TableName: tables.picks,
					Item: { ...pick, ...copy },
					ConditionExpression: 'attribute_not_exists(userId) OR updatedAt <= :u',
					ExpressionAttributeValues: { ':u': pick.updatedAt }
				})
			);
			report.rowsWritten++;
		} catch (err) {
			if (!isConditionFailure(err)) throw err;
			report.skippedNewer++;
		}
	}
	formatReport(report).forEach(log);
	return report;
}

const CLERK_USERS_URL = 'https://api.clerk.com/v1/users';
const CLERK_BATCH = 100;

/**
 * Look users up in Clerk's Backend API, 100 per request. Any non-2xx answer throws, which
 * aborts the migration before it writes: a 401 here means the wrong or a revoked key, and
 * treating it as "nobody exists" would skip every user as `notInClerk`.
 */
export function clerkUsersFetcher(secretKey: string, fetchImpl: typeof fetch = fetch) {
	return async (userIds: string[]): Promise<ClerkUsers> => {
		const found: ClerkUsers = {};
		for (let i = 0; i < userIds.length; i += CLERK_BATCH) {
			const batch = userIds.slice(i, i + CLERK_BATCH);
			const query = ['limit=100', ...batch.map((id) => `user_id=${encodeURIComponent(id.replace(CLERK_PREFIX, ''))}`)];
			const response = await fetchImpl(`${CLERK_USERS_URL}?${query.join('&')}`, {
				headers: { Authorization: `Bearer ${secretKey}` }
			});
			if (!response.ok) throw new Error(`Clerk answered ${response.status}`);
			const users = (await response.json()) as { id: string; username?: string | null }[];
			for (const user of users) found[`clerk:${user.id}`] = { username: user.username?.trim() || null };
		}
		return found;
	};
}
