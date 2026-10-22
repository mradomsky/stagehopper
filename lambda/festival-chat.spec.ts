import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

/**
 * Festival chat (#205), driven through `handler(event)` with an in-memory stand-in for the
 * tables. This file has its own `send` mock on purpose: `index.spec.ts` shares one across
 * every flow, and a Query added to an existing flow would start answering older specs'
 * mocks too (learning #204). Here every command is answered per table.
 */

const send = vi.fn();

vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {} }));

vi.mock('@aws-sdk/lib-dynamodb', () => {
	const command = (name: string) =>
		class {
			__command = name;
			constructor(public input: Record<string, unknown>) {}
		};
	return {
		DynamoDBDocumentClient: { from: () => ({ send }) },
		QueryCommand: command('Query'),
		ScanCommand: command('Scan'),
		BatchWriteCommand: command('BatchWrite'),
		TransactWriteCommand: command('TransactWrite'),
		GetCommand: command('Get'),
		PutCommand: command('Put'),
		DeleteCommand: command('Delete'),
		UpdateCommand: command('Update')
	};
});

interface MockCommand {
	__command: string;
	input: Record<string, any>;
}

function commandsOfType(type: string, table?: string): MockCommand[] {
	return send.mock.calls
		.map(([c]) => c as MockCommand)
		.filter((c) => c.__command === type && (!table || c.input.TableName === table));
}

const RED = '#e74c3c';
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const A = { sub: 'a', name: 'Alex', email: 'a@example.com', scope: 'user', username: 'alex_h' };
const B = { sub: 'b', name: 'Sam', email: 'b@example.com', scope: 'user', username: 'sam' };
const ADMIN = { sub: 'adm', name: 'Ada', email: 'ada@example.com', scope: 'admin', username: 'ada' };

/** `left op right` for the comparison operators DynamoDB conditions use. */
function compare(left: string | number, op: string, right: string | number): boolean {
	switch (op) {
		case '<':
			return left < right;
		case '<=':
			return left <= right;
		case '>':
			return left > right;
		case '>=':
			return left >= right;
		default:
			throw new Error(`unsupported operator ${op}`);
	}
}

const bodyOf = (res: unknown) => JSON.parse((res as { body: string }).body);
const statusOf = (res: unknown) => (res as { statusCode: number }).statusCode;

describe('Festival chat (#205)', () => {
	let users: Record<string, Record<string, any>>;
	let messages: Record<string, Record<string, any>>;
	let picks: Record<string, any>[];
	let festivals: Set<string>;

	const conditionFailure = (extra: Record<string, unknown> = {}) =>
		Promise.reject(
			Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException', ...extra })
		);

	function wireTables() {
		users = {};
		messages = {};
		picks = [];
		festivals = new Set(['tmr26']);
		send.mockImplementation((c: MockCommand) => {
			const input = c.input;
			const v = input.ExpressionAttributeValues ?? {};
			switch (`${c.__command} ${input.TableName}`) {
				case 'Update stagehopper-users': {
					const userId = input.Key.userId as string;
					const old = users[userId];
					if (String(input.UpdateExpression).includes('lastPostedAt')) {
						// The condition is read, not re-implemented: the boundary is its operator.
						const [, op, ref] = /lastPostedAt (<=|<|>=|>) (:[a-z]+)/.exec(input.ConditionExpression) ?? [];
						if (old?.lastPostedAt !== undefined && !compare(old.lastPostedAt, op!, v[ref!])) {
							return conditionFailure();
						}
						users[userId] = { ...old, lastPostedAt: v[':now'] };
						return Promise.resolve({});
					}
					users[userId] = { ...old, userId, handle: v[':h'], name: v[':n'], email: v[':e'] };
					return Promise.resolve({ Attributes: old });
				}
				case 'Get stagehopper-festivals':
					return Promise.resolve({ Item: festivals.has(input.Key.id) ? { id: input.Key.id } : undefined });
				case 'Put stagehopper-messages':
					messages[`${input.Item.festivalId}|${input.Item.messageId}`] = input.Item;
					return Promise.resolve({});
				case 'Delete stagehopper-messages': {
					const key = `${input.Key.festivalId}|${input.Key.messageId}`;
					const row = messages[key];
					if (input.ConditionExpression && (!row || row.userId !== v[':me'])) {
						return conditionFailure(
							row && input.ReturnValuesOnConditionCheckFailure === 'ALL_OLD'
								? { Item: { userId: { S: row.userId } } }
								: {}
						);
					}
					delete messages[key];
					return Promise.resolve({});
				}
				case 'Query stagehopper-messages': {
					const festivalId = v[':f'] ?? v[':v'];
					let rows = Object.values(messages)
						.filter((r) => r.festivalId === festivalId)
						.sort((x, y) => (x.messageId < y.messageId ? -1 : 1));
					const range = /messageId (<=|<|>=|>) (:[a-z]+)/.exec(input.KeyConditionExpression);
					if (range) rows = rows.filter((r) => compare(r.messageId, range[1]!, v[range[2]!]));
					if (input.ScanIndexForward === false) rows.reverse();
					if (input.Limit) rows = rows.slice(0, input.Limit);
					return Promise.resolve({ Items: rows });
				}
				case 'Query stagehopper-picks':
					return Promise.resolve({ Items: picks.filter((p) => p.festivalId === (v[':f'] ?? v[':v'])) });
				default:
					return Promise.resolve({ Items: [] });
			}
		});
	}

	beforeEach(() => {
		vi.resetModules();
		send.mockReset();
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(T0);
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
		process.env.USERS_TABLE = 'stagehopper-users';
		process.env.PICKS_TABLE = 'stagehopper-picks';
		process.env.FESTIVALS_TABLE = 'stagehopper-festivals';
		process.env.MESSAGES_TABLE = 'stagehopper-messages';
		wireTables();
	});

	afterEach(() => {
		vi.useRealTimers();
		for (const k of ['SITE_ORIGIN', 'USERS_TABLE', 'PICKS_TABLE', 'FESTIVALS_TABLE', 'MESSAGES_TABLE']) {
			delete process.env[k];
		}
	});

	async function call(
		routeKey: string,
		{
			body,
			rawBody,
			claims = A,
			id = 'tmr26',
			messageId,
			query
		}: {
			body?: unknown;
			rawBody?: string;
			claims?: Record<string, unknown> | null;
			id?: string;
			messageId?: string;
			query?: Record<string, string>;
		} = {}
	) {
		const { handler } = await import('./index.js');
		return handler({
			headers: {},
			routeKey,
			pathParameters: { id, ...(messageId !== undefined && { messageId }) },
			...(query && { queryStringParameters: query }),
			...(rawBody !== undefined
				? { body: rawBody }
				: body !== undefined && { body: JSON.stringify(body) }),
			requestContext: claims ? { authorizer: { jwt: { claims } } } : {}
		} as unknown as APIGatewayProxyEventV2);
	}

	const list = (query?: Record<string, string>, o: Parameters<typeof call>[1] = {}) =>
		call('GET /api/stagehopper/festivals/{id}/messages', { claims: null, query, ...o });
	const post = (text: unknown, o: Parameters<typeof call>[1] = {}) =>
		call('POST /api/stagehopper/festivals/{id}/messages', { body: { text }, ...o });
	const del = (messageId: string, o: Parameters<typeof call>[1] = {}) =>
		call('DELETE /api/stagehopper/festivals/{id}/messages/{messageId}', { messageId, ...o });
	const summary = (o: Parameters<typeof call>[1] = {}) =>
		call('GET /api/stagehopper/festivals/{id}/summary', { claims: null, ...o });

	/** A user who has chosen a colour, as `PUT users/me/profile` leaves them. */
	function seedUser(claims: Record<string, unknown>, extra: Record<string, unknown> = {}) {
		const userId = `clerk:${claims.sub}`;
		users[userId] = { userId, handle: claims.username, colour: RED, ...extra };
	}

	/** Messages straight into the table: id is the zero-padded ms plus a fixed suffix. */
	function seedMessages(count: number, { userId = 'clerk:a', festivalId = 'tmr26' } = {}) {
		const ids: string[] = [];
		for (let i = 0; i < count; i++) {
			const messageId = `${String(1_700_000_000_000 + i).padStart(13, '0')}-aaaaaaaa`;
			ids.push(messageId);
			messages[`${festivalId}|${messageId}`] = {
				festivalId,
				messageId,
				userId,
				handle: 'alex_h',
				colour: RED,
				text: `m${i}`,
				createdAt: 1_700_000_000_000 + i
			};
		}
		return ids;
	}

	beforeEach(() => {
		seedUser(A);
		seedUser(B);
	});

	describe('POST messages', () => {
		it('stores the trimmed text with the poster handle and colour, and returns it with the user id', async () => {
			const res = await post('  hello there  ');

			expect(statusOf(res)).toBe(201);
			const { message } = bodyOf(res);
			expect(message).toEqual({
				messageId: expect.stringMatching(/^\d{13}-[0-9a-z]{8}$/),
				userId: 'clerk:a',
				handle: 'alex_h',
				colour: RED,
				text: 'hello there',
				createdAt: T0
			});
			expect(Object.values(messages)).toEqual([
				expect.objectContaining({
					festivalId: 'tmr26',
					userId: 'clerk:a',
					text: 'hello there',
					messageId: message.messageId
				})
			]);
		});

		it('is found by the very next after= poll, and only it', async () => {
			const first = bodyOf(await post('first')).message;
			vi.setSystemTime(T0 + 5000);
			const posted = bodyOf(await post('second')).message;

			const polled = bodyOf(await list({ after: first.messageId }));

			expect(polled.messages).toEqual([posted]);
		});

		it.each([['blank', '   '], ['empty', ''], ['too long after trim', 'x'.repeat(501)], ['not a string', 7]])(
			'rejects text that is %s with 400 and stores nothing',
			async (_label, text) => {
				const res = await post(text);

				expect(statusOf(res)).toBe(400);
				expect(commandsOfType('Put', 'stagehopper-messages')).toHaveLength(0);
			}
		);

		it('accepts exactly 500 characters once trimmed', async () => {
			expect(statusOf(await post(` ${'x'.repeat(500)} `))).toBe(201);
		});

		it('rejects malformed JSON, a malformed festival id and a missing token', async () => {
			expect(statusOf(await call('POST /api/stagehopper/festivals/{id}/messages', { rawBody: '{' }))).toBe(400);
			expect(statusOf(await post('hi', { id: 'Not An Id' }))).toBe(400);
			expect(statusOf(await post('hi', { claims: null }))).toBe(401);
		});

		it('rejects a caller whose token carries no username', async () => {
			const res = await post('hi', { claims: { ...A, username: undefined } });

			expect(statusOf(res)).toBe(400);
			expect(bodyOf(res).error).toBe('handle is required');
		});

		it('rejects a Festival that does not exist', async () => {
			const res = await post('hi', { id: 'nope26' });

			expect(statusOf(res)).toBe(400);
			expect(commandsOfType('Put', 'stagehopper-messages')).toHaveLength(0);
		});

		it('asks a user with no colour to choose one first, and stores nothing', async () => {
			delete users['clerk:a']!.colour;

			const res = await post('hi');

			expect(statusOf(res)).toBe(400);
			expect(bodyOf(res).error).toBe('choose a colour first');
			expect(commandsOfType('Put', 'stagehopper-messages')).toHaveLength(0);
		});

		it('refuses a banned user with 403, without a rate-limit write or a Message', async () => {
			users['clerk:a']!.banned = true;

			const res = await post('hi');

			expect(statusOf(res)).toBe(403);
			expect(commandsOfType('Put', 'stagehopper-messages')).toHaveLength(0);
			expect(users['clerk:a']!.lastPostedAt).toBeUndefined();
		});

		it('tells a banned user without a colour about the ban, not the colour', async () => {
			users['clerk:a']!.banned = true;
			delete users['clerk:a']!.colour;

			expect(statusOf(await post('hi'))).toBe(403);
		});

		it('lets a banned user keep reading', async () => {
			users['clerk:a']!.banned = true;

			expect(statusOf(await list())).toBe(200);
		});

		it('answers 429 for a second post within 2 s and accepts one at exactly 2 s', async () => {
			expect(statusOf(await post('one'))).toBe(201);

			vi.setSystemTime(T0 + 1000);
			const tooSoon = await post('two');
			expect(statusOf(tooSoon)).toBe(429);
			expect(Object.keys(messages)).toHaveLength(1);

			vi.setSystemTime(T0 + 2000);
			expect(statusOf(await post('three'))).toBe(201);
			expect(Object.keys(messages)).toHaveLength(2);
		});

		it('rate limits per user, not per Festival or globally', async () => {
			expect(statusOf(await post('one'))).toBe(201);

			expect(statusOf(await post('other user', { claims: B }))).toBe(201);
		});

		it('mints ids that sort in post order within one millisecond and 2 s apart', async () => {
			const ids: string[] = [];
			for (const claims of [A, B, ADMIN]) {
				seedUser(claims);
				ids.push(bodyOf(await post('same ms', { claims })).message.messageId);
			}
			vi.setSystemTime(T0 + 2000);
			ids.push(bodyOf(await post('later')).message.messageId);

			expect([...ids].sort()).toEqual(ids);
			expect(new Set(ids).size).toBe(4);
		});

		it('keeps the real time as createdAt even when the id had to be nudged', async () => {
			seedUser(ADMIN);
			await post('one');
			const second = bodyOf(await post('two', { claims: ADMIN })).message;

			expect(second.createdAt).toBe(T0);
		});
	});

	describe('GET messages', () => {
		it('answers 200 with an empty list, without a token', async () => {
			const res = await list();

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({ messages: [] });
		});

		it('carries the user id of every Message', async () => {
			seedMessages(1);

			const [m] = bodyOf(await list()).messages;

			expect(m).toEqual({
				messageId: expect.any(String),
				userId: 'clerk:a',
				handle: 'alex_h',
				colour: RED,
				text: 'm0',
				createdAt: 1_700_000_000_000
			});
		});

		it('pages 250 Messages: newest 200 first, then the 50 before, then nothing after the newest', async () => {
			const ids = seedMessages(250);

			const newest = bodyOf(await list()).messages;
			expect(newest.map((m: any) => m.messageId)).toEqual(ids.slice(50));

			const older = bodyOf(await list({ before: newest[0].messageId })).messages;
			expect(older.map((m: any) => m.messageId)).toEqual(ids.slice(0, 50));

			expect(bodyOf(await list({ after: ids[249]! })).messages).toEqual([]);
		});

		it('returns at most 200 Messages after a cursor, oldest first', async () => {
			const ids = seedMessages(250);

			const page = bodyOf(await list({ after: ids[0]! })).messages;

			expect(page.map((m: any) => m.messageId)).toEqual(ids.slice(1, 201));
		});

		it('accepts a bare 13-digit timestamp as a cursor and includes that millisecond', async () => {
			const ids = seedMessages(3);

			const page = bodyOf(await list({ after: '1700000000000' })).messages;

			expect(page.map((m: any) => m.messageId)).toEqual(ids);
		});

		it('treats an empty after= or before= as absent', async () => {
			seedMessages(2);

			expect(bodyOf(await list({ after: '' })).messages).toHaveLength(2);
			expect(bodyOf(await list({ before: '' })).messages).toHaveLength(2);
		});

		it.each([
			['a malformed after', { after: 'abc' }],
			['a malformed before', { before: '12345-xyz' }],
			['an uppercase suffix', { after: '1700000000000-AAAAAAAA' }],
			['both after and before', { after: '1700000000000', before: '1700000000001' }]
		])('rejects %s with 400', async (_label, query) => {
			expect(statusOf(await list(query))).toBe(400);
		});

		it('rejects a malformed festival id', async () => {
			expect(statusOf(await list(undefined, { id: 'Not An Id' }))).toBe(400);
		});

		it('only lists the Messages of the requested Festival', async () => {
			seedMessages(2, { festivalId: 'other26' });

			expect(bodyOf(await list()).messages).toEqual([]);
		});
	});

	describe('DELETE messages/{messageId}', () => {
		const ID = '1700000000000-aaaaaaaa';

		beforeEach(() => {
			messages[`tmr26|${ID}`] = {
				festivalId: 'tmr26',
				messageId: ID,
				userId: 'clerk:a',
				handle: 'alex_h',
				colour: RED,
				text: 'mine',
				createdAt: 1
			};
		});

		it('lets the author delete their own Message', async () => {
			const res = await del(ID);

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({ ok: true });
			expect(messages[`tmr26|${ID}`]).toBeUndefined();
		});

		it("refuses another user's delete with 403 and keeps the row", async () => {
			const res = await del(ID, { claims: B });

			expect(statusOf(res)).toBe(403);
			expect(messages[`tmr26|${ID}`]).toBeDefined();
		});

		it('lets an Admin delete anyone’s Message', async () => {
			const res = await del(ID, { claims: ADMIN });

			expect(statusOf(res)).toBe(200);
			expect(messages[`tmr26|${ID}`]).toBeUndefined();
		});

		it('answers 200 for an id that does not exist, for the author and for an Admin', async () => {
			const unknown = '1700000000009-bbbbbbbb';

			expect(statusOf(await del(unknown))).toBe(200);
			expect(statusOf(await del(unknown, { claims: ADMIN }))).toBe(200);
			expect(messages[`tmr26|${ID}`]).toBeDefined();
		});

		it('rejects a malformed message id, a malformed festival id and a missing token', async () => {
			expect(statusOf(await del('nope'))).toBe(400);
			expect(statusOf(await del(ID, { id: 'Not An Id' }))).toBe(400);
			expect(statusOf(await del(ID, { claims: null }))).toBe(401);
			expect(messages[`tmr26|${ID}`]).toBeDefined();
		});
	});

	describe('GET summary', () => {
		it('counts each user once across Picks and Messages, and returns the newest Message', async () => {
			picks.push({ festivalId: 'tmr26', userId: 'clerk:x' });
			messages['tmr26|1700000000000-aaaaaaaa'] = {
				festivalId: 'tmr26',
				messageId: '1700000000000-aaaaaaaa',
				userId: 'clerk:x',
				handle: 'xx',
				colour: RED,
				text: 'x says',
				createdAt: 1_700_000_000_000
			};
			messages['tmr26|1700000000005-bbbbbbbb'] = {
				festivalId: 'tmr26',
				messageId: '1700000000005-bbbbbbbb',
				userId: 'clerk:y',
				handle: 'yy',
				colour: RED,
				text: 'y says',
				createdAt: 1_700_000_000_005
			};

			const res = await summary();

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({
				attendees: 2,
				latestMessage: {
					messageId: '1700000000005-bbbbbbbb',
					userId: 'clerk:y',
					handle: 'yy',
					colour: RED,
					text: 'y says',
					createdAt: 1_700_000_000_005
				}
			});
		});

		it('is 0 attendees and a null latest Message for a quiet Festival', async () => {
			expect(bodyOf(await summary())).toEqual({ attendees: 0, latestMessage: null });
		});

		it('counts Picks-only users', async () => {
			picks.push({ festivalId: 'tmr26', userId: 'clerk:x' }, { festivalId: 'tmr26', userId: 'clerk:y' });

			expect(bodyOf(await summary()).attendees).toBe(2);
		});

		it('rejects a malformed festival id', async () => {
			expect(statusOf(await summary({ id: 'Not An Id' }))).toBe(400);
		});
	});
});

describe('listMessageKeysOf (#209)', () => {
	beforeEach(() => {
		vi.resetModules();
		send.mockReset();
		process.env.MESSAGES_TABLE = 'stagehopper-messages';
	});

	afterEach(() => {
		delete process.env.MESSAGES_TABLE;
	});

	it('queries the userId-index, follows the cursor, and drops rows missing a key', async () => {
		send
			.mockResolvedValueOnce({
				Items: [{ festivalId: 'tmr26', messageId: '1700000000000-aaaaaaaa' }, { festivalId: 'tmr26' }],
				LastEvaluatedKey: { userId: 'clerk:a', messageId: 'x' }
			})
			.mockResolvedValueOnce({
				Items: [{ festivalId: 'ps26', messageId: '1700000000001-bbbbbbbb' }, { messageId: 'orphan' }]
			});
		const { listMessageKeysOf } = await import('./chat.js');

		const keys = await listMessageKeysOf('clerk:a');

		expect(keys).toEqual([
			{ festivalId: 'tmr26', messageId: '1700000000000-aaaaaaaa' },
			{ festivalId: 'ps26', messageId: '1700000000001-bbbbbbbb' }
		]);
		const [first, second] = send.mock.calls.map(([c]) => (c as MockCommand).input);
		expect(first).toMatchObject({
			TableName: 'stagehopper-messages',
			IndexName: 'userId-index',
			ExpressionAttributeValues: { ':u': 'clerk:a' }
		});
		expect(second!.ExclusiveStartKey).toEqual({ userId: 'clerk:a', messageId: 'x' });
	});
});
