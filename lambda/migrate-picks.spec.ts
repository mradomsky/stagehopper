import { describe, it, expect } from 'vitest';
import { PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
	clerkUsersFetcher,
	mergePicks,
	migratePicks,
	type MergeInput,
	type PicksRow,
	type SelectionRow
} from './migrate-picks.js';

const U = 'clerk:u1';

function input(over: Partial<MergeInput> = {}): MergeInput {
	return {
		selectionRows: [],
		users: [{ userId: U, rooms: { 'tmr26-aaaaaa': { updatedAt: 100 } } }],
		roomFestivals: {},
		festivalIds: ['tmr26'],
		performanceIds: { tmr26: ['p1', 'p2', 'p3'] },
		clerkUsers: { [U]: { username: 'alice' } },
		...over
	};
}

function row(roomId: string, selections: SelectionRow['selections'], over: Partial<SelectionRow> = {}): SelectionRow {
	return { roomId, userId: U, name: 'Room Alice', color: '#E74C3C', selections, ...over };
}

describe('mergePicks', () => {
	describe('combining Rooms into one Festival row', () => {
		it('takes the stronger state per Performance across Rooms: going beats maybe', () => {
			const { picks } = mergePicks(
				input({
					users: [
						{ userId: U, rooms: { 'tmr26-aaaaaa': { updatedAt: 100 }, 'tmr26-bbbbbb': { updatedAt: 200 } } }
					],
					selectionRows: [
						row('tmr26-aaaaaa', { p1: 2, p2: 1 }),
						row('tmr26-bbbbbb', { p1: 1, p2: 2, p3: 2 })
					]
				})
			);
			expect(picks).toHaveLength(1);
			expect(picks[0]?.selections).toEqual({ p1: 1, p2: 1, p3: 2 });
		});

		it('drops 0 states and writes no row when nothing is left', () => {
			const { picks } = mergePicks(input({ selectionRows: [row('tmr26-aaaaaa', { p1: 0, p2: 0 })] }));
			expect(picks).toEqual([]);
		});

		it('drops Performance ids the Festival does not have and counts them', () => {
			const { picks, report } = mergePicks(
				input({ selectionRows: [row('tmr26-aaaaaa', { p1: 1, gone: 1, other: 2 })] })
			);
			expect(picks[0]?.selections).toEqual({ p1: 1 });
			expect(report.stalePerformances).toBe(2);
		});

		it('emits the Picks item shape with updatedAt from the newest contributing Room', () => {
			const { picks } = mergePicks(
				input({
					users: [
						{ userId: U, rooms: { 'tmr26-aaaaaa': { updatedAt: 100 }, 'tmr26-bbbbbb': { updatedAt: 300 } } }
					],
					selectionRows: [row('tmr26-aaaaaa', { p1: 1 }), row('tmr26-bbbbbb', { p2: 2 })]
				})
			);
			expect(picks[0]).toEqual({
				festivalId: 'tmr26',
				userId: U,
				handle: 'alice',
				colour: '#e74c3c',
				selections: { p1: 1, p2: 2 },
				updatedAt: 300
			});
		});
	});

	describe('which Festival a Room belongs to', () => {
		it('uses the room id prefix', () => {
			const { picks } = mergePicks(input({ selectionRows: [row('tmr26-aaaaaa', { p1: 1 })] }));
			expect(picks[0]?.festivalId).toBe('tmr26');
		});

		it('uses the rooms-table Festival for a custom id', () => {
			const { picks } = mergePicks(
				input({
					users: [{ userId: U, rooms: { 'my-crew': { updatedAt: 5 } } }],
					roomFestivals: { 'my-crew': 'tmr26' },
					selectionRows: [row('my-crew', { p1: 1 })]
				})
			);
			expect(picks[0]?.festivalId).toBe('tmr26');
		});

		it('drops and counts Rooms with no or an unknown Festival', () => {
			const { picks, report } = mergePicks(
				input({
					users: [{ userId: U, rooms: {} }],
					roomFestivals: { 'orphan-x': 'deleted-fest' },
					selectionRows: [
						row('no-festival', { p1: 1 }),
						row('orphan-x', { p1: 1 }),
						row('old26-aaaaaa', { p1: 1 })
					]
				})
			);
			expect(picks).toEqual([]);
			expect(report.roomsDropped).toBe(3);
			expect(report.droppedRoomIds).toEqual(['no-festival', 'old26-aaaaaa', 'orphan-x']);
		});
	});
});

describe('mergePicks: who is migrated, with which Handle and Colour', () => {
	const one = { tmr26: ['p1'] };
	const withUser = (user: Record<string, unknown>, over: Partial<MergeInput> = {}) =>
		input({
			users: [{ userId: U, rooms: { 'tmr26-aaaaaa': { updatedAt: 100 } }, ...user }],
			selectionRows: [row('tmr26-aaaaaa', { p1: 1 })],
			performanceIds: one,
			...over
		});

	it('skips the @room name row and non-clerk ids', () => {
		const { picks, report } = mergePicks(
			input({
				selectionRows: [
					row('tmr26-aaaaaa', { p1: 1 }),
					row('tmr26-aaaaaa', {}, { userId: '@room' }),
					row('tmr26-aaaaaa', { p1: 1 }, { userId: 'anon:xyz' })
				]
			})
		);
		expect(picks.map((p) => p.userId)).toEqual([U]);
		expect(report.legacyKeys).toBe(1);
	});

	it('skips a user with no users row', () => {
		const { picks, report } = mergePicks(withUser({}, { users: [] }));
		expect(picks).toEqual([]);
		expect(report.noUserRow).toEqual([U]);
	});

	it('counts a Room with no recency and treats it as oldest', () => {
		const { report } = mergePicks(withUser({ rooms: {} }));
		expect(report.noRecency).toBe(1);
	});

	describe('Handle', () => {
		it('keeps the users-row handle over Clerk', () => {
			expect(mergePicks(withUser({ handle: 'kept' })).picks[0]?.handle).toBe('kept');
		});

		it('uses the Clerk username when the users row has none', () => {
			expect(mergePicks(withUser({})).picks[0]?.handle).toBe('alice');
		});

		it('falls back to the most recent Room name when Clerk has no username', () => {
			const { picks } = mergePicks(
				withUser(
					{ rooms: { 'tmr26-aaaaaa': { updatedAt: 1 }, 'tmr26-bbbbbb': { updatedAt: 2 } } },
					{
						clerkUsers: { [U]: { username: null } },
						selectionRows: [
							row('tmr26-aaaaaa', { p1: 1 }, { name: 'Old' }),
							row('tmr26-bbbbbb', { p1: 1 }, { name: 'Newest' })
						]
					}
				)
			);
			expect(picks[0]?.handle).toBe('Newest');
		});

		it('skips a user Clerk no longer has, even with a users-row handle', () => {
			const { picks, report } = mergePicks(withUser({ handle: 'x' }, { clerkUsers: {} }));
			expect(picks).toEqual([]);
			expect(report.notInClerk).toEqual([U]);
		});

		it('skips and reports a user with no Handle from any source', () => {
			const { picks, userUpdates, report } = mergePicks(
				withUser(
					{},
					{
						clerkUsers: { [U]: { username: null } },
						selectionRows: [row('tmr26-aaaaaa', { p1: 1 }, { name: '' })]
					}
				)
			);
			expect(picks).toEqual([]);
			expect(userUpdates).toEqual([]);
			expect(report.noHandle).toEqual([U]);
		});
	});

	describe('Colour', () => {
		it('keeps the users-row colour', () => {
			expect(mergePicks(withUser({ colour: '#3498db' })).picks[0]?.colour).toBe('#3498db');
		});

		it('uses the most recent palette Room colour, lowercased', () => {
			const { picks, report } = mergePicks(
				withUser(
					{ rooms: { 'tmr26-aaaaaa': { updatedAt: 1 }, 'tmr26-bbbbbb': { updatedAt: 2 } } },
					{
						selectionRows: [
							row('tmr26-aaaaaa', { p1: 1 }, { color: '#3498DB' }),
							row('tmr26-bbbbbb', { p1: 1 }, { color: '#not-palette' })
						]
					}
				)
			);
			expect(picks[0]?.colour).toBe('#3498db');
			expect(report.coloursDefaulted).toEqual([]);
		});

		it('defaults to the first palette colour and lists the user', () => {
			const { picks, report, userUpdates } = mergePicks(
				withUser({}, { selectionRows: [row('tmr26-aaaaaa', { p1: 1 }, { color: undefined })] })
			);
			expect(picks[0]?.colour).toBe('#e74c3c');
			expect(userUpdates).toEqual([{ userId: U, handle: 'alice', colour: '#e74c3c' }]);
			expect(report.coloursDefaulted).toEqual([U]);
		});
	});

	describe('against the existing Picks table', () => {
		const existing = (updatedAt: number) => ({
			festivalId: 'tmr26',
			userId: U,
			handle: 'alice',
			colour: '#e74c3c',
			selections: { p1: 1 as const },
			updatedAt
		});

		it('overwrites an equal row and leaves a strictly newer one, counting it', () => {
			expect(mergePicks(withUser({}, { existingPicks: [existing(100)] })).picks).toHaveLength(1);
			const newer = mergePicks(withUser({}, { existingPicks: [existing(101)] }));
			expect(newer.picks).toEqual([]);
			expect(newer.report.skippedNewer).toBe(1);
			expect(newer.report.rowsWritten).toBe(0);
		});

		it('counts an existing row the migration would not produce', () => {
			const stray = { ...existing(5), userId: 'clerk:other' };
			expect(mergePicks(withUser({}, { existingPicks: [stray] })).report.unexpectedRows).toBe(1);
		});
	});

	it('sorts rows by festivalId then userId', () => {
		const rooms = { 'tmr26-aaaaaa': { updatedAt: 1 } };
		const { picks } = mergePicks(
			input({
				users: ['clerk:b', 'clerk:a'].map((userId) => ({ userId, handle: userId, colour: '#e74c3c', rooms })),
				clerkUsers: { 'clerk:a': { username: 'a' }, 'clerk:b': { username: 'b' } },
				performanceIds: one,
				selectionRows: [
					row('tmr26-aaaaaa', { p1: 1 }, { userId: 'clerk:b' }),
					row('tmr26-aaaaaa', { p1: 1 }, { userId: 'clerk:a' })
				]
			})
		);
		expect(picks.map((p) => p.userId)).toEqual(['clerk:a', 'clerk:b']);
	});
});

describe('migratePicks', () => {
	const T = {
		selections: 'sel',
		users: 'users',
		rooms: 'rooms',
		festivals: 'fests',
		performances: 'perfs',
		picks: 'picks'
	};
	type Item = Record<string, unknown>;

	const conditionFailure = () =>
		Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });

	/** A DynamoDB stand-in that answers per command class and TableName, and records every write. */
	function fakeDb(seed: Partial<Record<keyof typeof T, object[]>> = {}) {
		const db: Record<string, Item[]> = {
			sel: [
				{
					roomId: 'tmr26-aaaaaa',
					userId: 'clerk:u1',
					name: 'Crew',
					color: '#3498DB',
					selections: { p1: 1, p2: 2, gone: 1 }
				},
				{ roomId: 'tmr26-aaaaaa', userId: 'clerk:u2', name: 'Crew', color: '#2ecc71', selections: { p2: 1 } },
				{ roomId: 'tmr26-aaaaaa', userId: '@room', displayName: 'Crew' }
			],
			users: [
				{ userId: 'clerk:u1', rooms: { 'tmr26-aaaaaa': { updatedAt: 500 } } },
				{
					userId: 'clerk:u2',
					handle: 'bob',
					colour: '#99e52e',
					rooms: { 'tmr26-aaaaaa': { updatedAt: 400 } }
				}
			],
			rooms: [],
			fests: [{ id: 'tmr26' }],
			perfs: [
				{ festivalId: 'tmr26', id: 'p1' },
				{ festivalId: 'tmr26', id: 'p2' }
			],
			picks: []
		};
		for (const [k, v] of Object.entries(seed)) db[T[k as keyof typeof T]] = v as Item[];
		const writes: { kind: string; input: Record<string, any> }[] = [];
		const consistent: boolean[] = [];
		const send = async (cmd: unknown) => {
			const input = (cmd as { input: Record<string, any> }).input;
			const rows = db[input.TableName as string] ?? [];
			if (cmd instanceof ScanCommand) {
				consistent.push(input.ConsistentRead === true);
				return { Items: structuredClone(rows) };
			}
			if (cmd instanceof UpdateCommand) {
				writes.push({ kind: 'Update', input });
				const user = rows.find((r) => r.userId === input.Key.userId);
				if (!user) throw conditionFailure();
				user.handle ??= input.ExpressionAttributeValues[':h'];
				user.colour ??= input.ExpressionAttributeValues[':c'];
				return { Attributes: structuredClone(user) };
			}
			if (cmd instanceof PutCommand) {
				writes.push({ kind: 'Put', input });
				const item = input.Item as PicksRow;
				const at = rows.findIndex((r) => r.festivalId === item.festivalId && r.userId === item.userId);
				if (at >= 0 && (rows[at] as unknown as PicksRow).updatedAt > item.updatedAt) {
					throw conditionFailure();
				}
				const copy = structuredClone(item) as unknown as Item;
				if (at >= 0) rows[at] = copy;
				else rows.push(copy);
				return {};
			}
			throw new Error(`unexpected command ${(cmd as object).constructor.name}`);
		};
		return { db, send, writes, consistent };
	}

	const clerk = async (ids: string[]) =>
		Object.fromEntries(ids.map((id) => [id, { username: id === 'clerk:u1' ? 'alice' : null }]));

	async function run(fake: ReturnType<typeof fakeDb>, dryRun: boolean, fetchClerkUsers = clerk) {
		const lines: string[] = [];
		const report = await migratePicks({
			send: fake.send,
			fetchClerkUsers,
			tables: T,
			dryRun,
			log: (l) => lines.push(l)
		});
		return { report, out: lines.join('\n') };
	}

	const puts = (f: ReturnType<typeof fakeDb>) => f.writes.filter((w) => w.kind === 'Put');

	it('dry run sends no write and prints the counts the real run prints', async () => {
		const dry = fakeDb();
		const dryRun = await run(dry, true);
		expect(dry.writes).toEqual([]);
		expect(dryRun.report).toMatchObject({ users: 2, festivals: 1, rowsWritten: 2, roomsDropped: 0 });

		const real = fakeDb();
		const realRun = await run(real, false);
		expect(real.writes.length).toBeGreaterThan(0);
		expect(realRun.out).toBe(dryRun.out);
		expect(dryRun.out).toContain('rows written: 2');
	});

	it('scans every table with a consistent read', async () => {
		const f = fakeDb();
		await run(f, true);
		expect(f.consistent).toHaveLength(6);
		expect(f.consistent.every(Boolean)).toBe(true);
	});

	it('writes the Picks item shape, 0-states and stale Performances dropped', async () => {
		const f = fakeDb();
		await run(f, false);
		expect(f.db.picks).toEqual([
			{
				festivalId: 'tmr26',
				userId: 'clerk:u1',
				handle: 'alice',
				colour: '#3498db',
				selections: { p1: 1, p2: 2 },
				updatedAt: 500
			},
			{
				festivalId: 'tmr26',
				userId: 'clerk:u2',
				handle: 'bob',
				colour: '#99e52e',
				selections: { p2: 1 },
				updatedAt: 400
			}
		]);
	});

	it('a second real run puts byte-identical items and prints identical counts', async () => {
		const f = fakeDb();
		const first = await run(f, false);
		const firstPuts = puts(f).map((w) => JSON.stringify(w.input.Item));
		f.writes.length = 0;
		const second = await run(f, false);
		expect(puts(f).map((w) => JSON.stringify(w.input.Item))).toEqual(firstPuts);
		expect(second.out).toBe(first.out);
	});

	it('sets handle and colour on the users row only where missing, and Picks copy the result', async () => {
		const f = fakeDb();
		await run(f, false);
		const updates = f.writes.filter((w) => w.kind === 'Update');
		expect(updates).toHaveLength(2);
		for (const u of updates) {
			expect(u.input).toMatchObject({
				TableName: 'users',
				UpdateExpression: 'SET handle = if_not_exists(handle, :h), colour = if_not_exists(colour, :c)',
				ConditionExpression: 'attribute_exists(userId)',
				ReturnValues: 'ALL_NEW'
			});
		}
		expect(f.db.users!.find((u) => u.userId === 'clerk:u1')).toMatchObject({
			handle: 'alice',
			colour: '#3498db'
		});
		expect(f.db.users!.find((u) => u.userId === 'clerk:u2')).toMatchObject({
			handle: 'bob',
			colour: '#99e52e'
		});
	});

	it('puts Picks rows only when absent or not newer, and counts a lost race as skippedNewer', async () => {
		const f = fakeDb();
		const racing = async (cmd: unknown) => {
			if (cmd instanceof PutCommand && (cmd.input.Item as PicksRow).userId === 'clerk:u2') {
				throw conditionFailure();
			}
			return f.send(cmd);
		};
		const report = await migratePicks({
			send: racing,
			fetchClerkUsers: clerk,
			tables: T,
			dryRun: false,
			log: () => {}
		});
		const put = puts(f)[0]?.input;
		expect(put?.ConditionExpression).toBe('attribute_not_exists(userId) OR updatedAt <= :u');
		expect(put?.ExpressionAttributeValues).toEqual({ ':u': 500 });
		expect(report.skippedNewer).toBe(1);
		expect(report.rowsWritten).toBe(1);
	});

	describe('live-save guard', () => {
		const live = (over: Partial<PicksRow>): PicksRow => ({
			festivalId: 'tmr26',
			userId: 'clerk:u1',
			handle: 'alice',
			colour: '#3498db',
			selections: { p1: 1 },
			updatedAt: 500,
			...over
		});

		it('refuses a real run, with zero writes, when a Picks row is strictly newer', async () => {
			const f = fakeDb({ picks: [live({ updatedAt: 501 })] });
			await expect(run(f, false)).rejects.toThrow(/refus/i);
			expect(f.writes).toEqual([]);
		});

		it('refuses a real run when the Picks table holds a row the migration would not produce', async () => {
			const f = fakeDb({ picks: [live({ userId: 'clerk:stranger' })] });
			await expect(run(f, false)).rejects.toThrow(/refus/i);
			expect(f.writes).toEqual([]);
		});

		it('a dry run reports them instead of refusing', async () => {
			const f = fakeDb({ picks: [live({ updatedAt: 501 }), live({ userId: 'clerk:stranger' })] });
			const { report } = await run(f, true);
			expect(report).toMatchObject({ skippedNewer: 1, unexpectedRows: 1 });
			expect(f.writes).toEqual([]);
		});
	});

	it('aborts before any write when Clerk fails', async () => {
		const f = fakeDb();
		await expect(
			run(f, false, async () => {
				throw new Error('Clerk 401');
			})
		).rejects.toThrow('Clerk 401');
		expect(f.writes).toEqual([]);
	});

	it('asks Clerk only about users that have a users row', async () => {
		const f = fakeDb();
		f.db.sel!.push({ roomId: 'tmr26-aaaaaa', userId: 'clerk:orphan', selections: { p1: 1 } });
		const asked: string[][] = [];
		await run(f, true, async (ids) => {
			asked.push(ids);
			return clerk(ids);
		});
		expect(asked).toEqual([['clerk:u1', 'clerk:u2']]);
	});
});

describe('clerkUsersFetcher', () => {
	it('batches ids, sends the Bearer secret, and keys the answer by clerk: user id', async () => {
		const calls: { url: string; auth: string | null }[] = [];
		const fetchImpl = (async (url: string, init: RequestInit) => {
			calls.push({ url, auth: new Headers(init.headers).get('authorization') });
			return new Response(
				JSON.stringify([
					{ id: 'u1', username: 'alice' },
					{ id: 'u2', username: null }
				]),
				{ status: 200 }
			);
		}) as unknown as typeof fetch;
		const ids = Array.from({ length: 150 }, (_, i) => `clerk:u${i}`);
		const found = await clerkUsersFetcher('sk_test', fetchImpl)(ids);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.auth).toBe('Bearer sk_test');
		expect(calls[0]?.url).toMatch(/^https:\/\/api\.clerk\.com\/v1\/users\?limit=100&user_id=u0&user_id=u1/);
		expect(found['clerk:u1']).toEqual({ username: 'alice' });
		expect(found['clerk:u2']).toEqual({ username: null });
	});

	it('throws on a non-2xx answer', async () => {
		const fetchImpl = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
		await expect(clerkUsersFetcher('bad', fetchImpl)(['clerk:u1'])).rejects.toThrow(/401/);
	});
});
