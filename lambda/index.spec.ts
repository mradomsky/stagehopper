import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const send = vi.fn();
const s3Send = vi.fn();
const cloudfrontSend = vi.fn();
const lambdaSend = vi.fn();
const getSignedUrl = vi.fn();

// The SDK entry points are constructed with `new`, so the stubs are classes.
vi.mock('@aws-sdk/client-dynamodb', () => ({
	DynamoDBClient: class {}
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
	DynamoDBDocumentClient: { from: () => ({ send }) },
	QueryCommand: class {
		__command = 'Query';
		constructor(public input: Record<string, unknown>) {}
	},
	ScanCommand: class {
		__command = 'Scan';
		constructor(public input: Record<string, unknown>) {}
	},
	BatchWriteCommand: class {
		__command = 'BatchWrite';
		constructor(public input: Record<string, unknown>) {}
	},
	TransactWriteCommand: class {
		__command = 'TransactWrite';
		constructor(public input: Record<string, unknown>) {}
	},
	GetCommand: class {
		__command = 'Get';
		constructor(public input: Record<string, unknown>) {}
	},
	PutCommand: class {
		__command = 'Put';
		constructor(public input: Record<string, unknown>) {}
	},
	DeleteCommand: class {
		__command = 'Delete';
		constructor(public input: Record<string, unknown>) {}
	},
	UpdateCommand: class {
		__command = 'Update';
		constructor(public input: Record<string, unknown>) {}
	}
}));

vi.mock('@aws-sdk/client-s3', () => ({
	S3Client: class {
		send = s3Send;
	},
	PutObjectCommand: class {
		__command = 'PutObject';
		constructor(public input: Record<string, unknown>) {}
	},
	GetObjectCommand: class {
		__command = 'GetObject';
		constructor(public input: Record<string, unknown>) {}
	},
	DeleteObjectCommand: class {
		__command = 'DeleteObject';
		constructor(public input: Record<string, unknown>) {}
	}
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
	getSignedUrl: (...args: unknown[]) => getSignedUrl(...args)
}));

vi.mock('@aws-sdk/client-cloudfront', () => ({
	CloudFrontClient: class {
		send = cloudfrontSend;
	},
	CreateInvalidationCommand: class {
		__command = 'CreateInvalidation';
		constructor(public input: Record<string, unknown>) {}
	}
}));

vi.mock('@aws-sdk/client-lambda', () => ({
	LambdaClient: class {
		send = lambdaSend;
	},
	InvokeCommand: class {
		__command = 'Invoke';
		constructor(public input: Record<string, unknown>) {}
	}
}));

/** Import fresh so module-level env reads (table names, client id) apply per test. */
async function loadLambda() {
	return import('./index.js');
}

interface MockCommand {
	__command: string;
	input: Record<string, any>;
}

function commandsOfType(type: string): MockCommand[] {
	return send.mock.calls
		.map(([command]) => command as MockCommand)
		.filter((command) => command.__command === type);
}

/**
 * The claims API Gateway attaches after verifying a Clerk token — an ordinary signed-in
 * user. Nothing is signed and no token is constructed: verification happens at the gateway,
 * so the claim set is the whole of what the Lambda has to be tested against.
 */
const USER_CLAIMS = {
	sub: '1234567890',
	name: 'Alex Example',
	email: 'alex@example.com',
	scope: 'user'
};

/** The same caller, carrying the scope the admin routes are gated on. */
const ADMIN_CLAIMS = { ...USER_CLAIMS, scope: 'admin' };

/**
 * An event as the gateway delivers it. Claims default to a signed-in user, because that is
 * what every route but the public GET sees — anything else is rejected before the Lambda
 * runs. Pass `null` to model the public route, or a request that reached application code
 * with no authorizer attached.
 */
function event(
	overrides: Partial<APIGatewayProxyEventV2> = {},
	claims: Record<string, unknown> | null = USER_CLAIMS
): APIGatewayProxyEventV2 {
	return {
		headers: {},
		...overrides,
		requestContext: claims ? { authorizer: { jwt: { claims } } } : {}
	} as unknown as APIGatewayProxyEventV2;
}

function bodyOf(result: unknown): any {
	return JSON.parse((result as { body: string }).body);
}

function statusOf(result: unknown): number {
	return (result as { statusCode: number }).statusCode;
}

describe('readIdentity', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('keys the participant on the token subject', async () => {
		const { readIdentity } = await loadLambda();

		expect(readIdentity(event())).toEqual({
			participantKey: 'clerk:1234567890',
			name: 'Alex Example',
			email: 'alex@example.com',
			scopes: ['user']
		});
	});

	it('lowercases and trims the email claim', async () => {
		const { readIdentity } = await loadLambda();

		expect(readIdentity(event({}, { ...USER_CLAIMS, email: '  Alex@EXAMPLE.com ' }))).toMatchObject(
			{ email: 'alex@example.com' }
		);
	});

	it('truncates an over-long name claim', async () => {
		const { readIdentity } = await loadLambda();

		expect(readIdentity(event({}, { ...USER_CLAIMS, name: 'x'.repeat(80) }))?.name).toHaveLength(
			50
		);
	});

	it('tolerates a token with no name or email', async () => {
		const { readIdentity } = await loadLambda();

		expect(readIdentity(event({}, { sub: 'abc' }))).toEqual({
			participantKey: 'clerk:abc',
			name: '',
			email: '',
			scopes: []
		});
	});

	it('splits a multi-scope claim on whitespace', async () => {
		const { readIdentity } = await loadLambda();

		expect(readIdentity(event({}, { ...USER_CLAIMS, scope: 'admin  user' }))?.scopes).toEqual([
			'admin',
			'user'
		]);
	});

	it('returns null when the gateway attached no claims at all', async () => {
		const { readIdentity } = await loadLambda();

		expect(readIdentity(event({}, null))).toBeNull();
	});

	it('returns null for claims carrying no subject', async () => {
		const { readIdentity } = await loadLambda();

		expect(readIdentity(event({}, { name: 'Alex' }))).toBeNull();
	});

	// The property the whole cutover rests on: the participant key comes from a claim the
	// gateway verified, and a request body cannot reach it.
	it('ignores anything the request body claims about the caller', async () => {
		const { readIdentity } = await loadLambda();

		const identity = readIdentity(
			event({ body: JSON.stringify({ sub: 'someone-else', scope: 'admin' }) })
		);

		expect(identity?.participantKey).toBe('clerk:1234567890');
		expect(identity?.scopes).toEqual(['user']);
	});
});

describe('hasAdminScope', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('accepts a token carrying the admin scope', async () => {
		const { readIdentity, hasAdminScope } = await loadLambda();

		expect(hasAdminScope(readIdentity(event({}, ADMIN_CLAIMS))!)).toBe(true);
	});

	it('accepts admin alongside other scopes', async () => {
		const { readIdentity, hasAdminScope } = await loadLambda();

		expect(hasAdminScope(readIdentity(event({}, { ...USER_CLAIMS, scope: 'user admin' }))!)).toBe(
			true
		);
	});

	it('refuses a token without it', async () => {
		const { readIdentity, hasAdminScope } = await loadLambda();

		expect(hasAdminScope(readIdentity(event())!)).toBe(false);
	});

	// Substring matching would admit anyone who could get "administrator" into their claim,
	// so splitting before comparing is load-bearing rather than tidy.
	it('does not match a scope that merely starts with admin', async () => {
		const { readIdentity, hasAdminScope } = await loadLambda();

		expect(
			hasAdminScope(readIdentity(event({}, { ...USER_CLAIMS, scope: 'administrator' }))!)
		).toBe(false);
	});
});

describe('validatePutBody', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('accepts a well-formed body and trims the name', async () => {
		const { validatePutBody } = await loadLambda();

		const result = validatePutBody(
			JSON.stringify({
				name: '  Alex  ',
				color: '#e74c3c',
				selections: { a: 1 }
			})
		);

		expect(result.data).toEqual({
			name: 'Alex',
			color: '#e74c3c',
			selections: { a: 1 }
		});
	});

	it.each([
		['invalid json', '{not json', /invalid json/i],
		[
			'a malformed colour',
			JSON.stringify({ color: 'red', selections: {} }),
			/hex color/i
		],
		[
			'selections that are not an object',
			JSON.stringify({ color: '#e74c3c', selections: [1] }),
			/must be an object/i
		],
		[
			'an out-of-range selection value',
			JSON.stringify({ color: '#e74c3c', selections: { a: 3 } }),
			/0, 1, or 2/
		],
		[
			'an over-long selection key',
			JSON.stringify({
				color: '#e74c3c',
				selections: { ['x'.repeat(101)]: 1 }
			}),
			/invalid selection key/i
		],
		[
			'a non-string name',
			JSON.stringify({ color: '#e74c3c', selections: {}, name: 5 }),
			/name must be a string/i
		]
	])('rejects %s', async (_label, body, expected) => {
		const { validatePutBody } = await loadLambda();

		expect(validatePutBody(body).error).toMatch(expected);
	});

	it('rejects a selections map with too many entries', async () => {
		const { validatePutBody } = await loadLambda();
		const selections = Object.fromEntries(
			Array.from({ length: 5001 }, (_, index) => [`p${index}`, 1])
		);

		expect(
			validatePutBody(JSON.stringify({ color: '#e74c3c', selections })).error
		).toMatch(/too many selections/i);
	});

	it('rejects a selections map that would exceed the DynamoDB item limit', async () => {
		const { validatePutBody } = await loadLambda();
		// Few enough entries to pass the count check, but long keys make it oversized.
		const selections = Object.fromEntries(
			Array.from({ length: 4000 }, (_, index) => [`${index}`.padEnd(100, 'x'), 1])
		);

		expect(
			validatePutBody(JSON.stringify({ color: '#e74c3c', selections })).error
		).toMatch(/too large/i);
	});
});

describe('handler', () => {
	beforeEach(() => {
		vi.resetModules();
		send.mockReset();
		process.env.TABLE_NAME = 'stagehopper-selections';
		process.env.USERS_TABLE = 'stagehopper-users';
		process.env.ROOMS_TABLE = 'stagehopper-rooms';
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
	});

	afterEach(() => {
		delete process.env.TABLE_NAME;
		delete process.env.USERS_TABLE;
		delete process.env.ROOMS_TABLE;
		delete process.env.SITE_ORIGIN;
	});

	it('answers preflight without a body', async () => {
		const { handler } = await loadLambda();

		const res = await handler(event({ routeKey: 'OPTIONS /api/stagehopper/rooms' }));

		expect(statusOf(res)).toBe(200);
		expect((res as { body: string }).body).toBe('');
	});

	it('pins CORS to the configured site origin', async () => {
		const { handler } = await loadLambda();

		const res = await handler(
			event({ routeKey: 'OPTIONS /x', headers: { origin: 'https://evil.example' } })
		);

		expect(
			(res as { headers: Record<string, string> }).headers['Access-Control-Allow-Origin']
		).toBe('https://stagehopper.example');
	});

	it('returns 404 for an unknown route', async () => {
		const { handler } = await loadLambda();

		expect(statusOf(await handler(event({ routeKey: 'GET /nope' })))).toBe(404);
	});

	it('returns 500 when a DynamoDB call fails', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		send.mockImplementation(() => Promise.reject(new Error('throughput exceeded')));
		const { handler } = await loadLambda();

		const res = await handler(
			event({
				routeKey: 'GET /api/stagehopper/rooms/{roomId}/selections',
				pathParameters: { roomId: 'tmr26-abc123' }
			})
		);

		expect(statusOf(res)).toBe(500);
		consoleError.mockRestore();
	});

	describe('room registration', () => {
		it('echoes a valid requested room id', async () => {
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'POST /api/stagehopper/rooms',
					body: JSON.stringify({ roomId: 'tmr26-abc123' })
				})
			);

			expect(statusOf(res)).toBe(201);
			expect(bodyOf(res)).toEqual({ roomId: 'tmr26-abc123' });
		});

		it('generates an id when none is supplied', async () => {
			const { handler } = await loadLambda();

			const res = await handler(event({ routeKey: 'POST /api/stagehopper/rooms', body: '{}' }));

			expect(bodyOf(res).roomId).toMatch(/^ps26-[0-9a-f]{6}$/);
		});

		it('generates an id when the requested one is empty', async () => {
			const { handler } = await loadLambda();

			const res = await handler(
				event({ routeKey: 'POST /api/stagehopper/rooms', body: JSON.stringify({ roomId: '' }) })
			);

			expect(statusOf(res)).toBe(201);
			expect(bodyOf(res).roomId).toMatch(/^ps26-[0-9a-f]{6}$/);
		});

		it('rejects a malformed room id', async () => {
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'POST /api/stagehopper/rooms',
					body: JSON.stringify({ roomId: 'Not A Room!' })
				})
			);

			expect(statusOf(res)).toBe(400);
		});

		describe('with a display name', () => {
			it('saves it as an extra row under the room partition', async () => {
				send.mockResolvedValue({});
				const { handler } = await loadLambda();

				const res = await handler(
					event({
						routeKey: 'POST /api/stagehopper/rooms',
						body: JSON.stringify({ roomId: 'tmr26-abc123', displayName: 'Squad Goals' })
					})
				);

				expect(statusOf(res)).toBe(201);
				expect(bodyOf(res)).toEqual({ roomId: 'tmr26-abc123' });
				const [putCommand] = commandsOfType('Put');
				expect(putCommand?.input).toEqual({
					TableName: 'stagehopper-selections',
					Item: { roomId: 'tmr26-abc123', userId: '@room', displayName: 'Squad Goals' },
					ConditionExpression: 'attribute_not_exists(userId)'
				});
			});

			it('trims it before saving', async () => {
				send.mockResolvedValue({});
				const { handler } = await loadLambda();

				await handler(
					event({
						routeKey: 'POST /api/stagehopper/rooms',
						body: JSON.stringify({ roomId: 'tmr26-abc123', displayName: '  Squad Goals  ' })
					})
				);

				const [putCommand] = commandsOfType('Put');
				expect(putCommand?.input.Item.displayName).toBe('Squad Goals');
			});

			it.each([
				['empty after trimming', '   '],
				['over the length limit', 'x'.repeat(16)],
				['carrying a disallowed symbol', 'Squad!'],
				['not a string', 5]
			])('rejects a name %s', async (_label, displayName) => {
				const { handler } = await loadLambda();

				const res = await handler(
					event({
						routeKey: 'POST /api/stagehopper/rooms',
						body: JSON.stringify({ roomId: 'tmr26-abc123', displayName })
					})
				);

				expect(statusOf(res)).toBe(400);
				expect(send).not.toHaveBeenCalled();
			});

			it('keeps the existing name when the room is already named (first write wins)', async () => {
				send.mockImplementation(() => {
					const err = new Error('conditional check failed');
					err.name = 'ConditionalCheckFailedException';
					return Promise.reject(err);
				});
				const { handler } = await loadLambda();

				const res = await handler(
					event({
						routeKey: 'POST /api/stagehopper/rooms',
						body: JSON.stringify({ roomId: 'tmr26-abc123', displayName: 'Late Name' })
					})
				);

				expect(statusOf(res)).toBe(201);
				expect(bodyOf(res)).toEqual({ roomId: 'tmr26-abc123' });
			});

			it('reports a server error for an unexpected write failure', async () => {
				const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
				send.mockImplementation(() => Promise.reject(new Error('throughput exceeded')));
				const { handler } = await loadLambda();

				const res = await handler(
					event({
						routeKey: 'POST /api/stagehopper/rooms',
						body: JSON.stringify({ roomId: 'tmr26-abc123', displayName: 'Squad Goals' })
					})
				);

				expect(statusOf(res)).toBe(500);
				consoleError.mockRestore();
			});
		});
	});

	describe('reading selections', () => {
		it('queries the room partition', async () => {
			send.mockResolvedValue({ Items: [{ userId: 'clerk:1' }] });
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'GET /api/stagehopper/rooms/{roomId}/selections',
					pathParameters: { roomId: 'tmr26-abc123' }
				})
			);

			expect(bodyOf(res)).toEqual([{ userId: 'clerk:1' }]);
			expect(commandsOfType('Query')[0]?.input).toMatchObject({
				TableName: 'stagehopper-selections',
				ExpressionAttributeValues: { ':rid': 'tmr26-abc123' }
			});
		});

		it('rejects an invalid room id', async () => {
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'GET /api/stagehopper/rooms/{roomId}/selections',
					pathParameters: { roomId: '!!' }
				})
			);

			expect(statusOf(res)).toBe(400);
			expect(send).not.toHaveBeenCalled();
		});
	});

	describe('writing selections', () => {
		const putEvent = (body: unknown) =>
			event({
				routeKey: 'PUT /api/stagehopper/rooms/{roomId}/selections',
				pathParameters: { roomId: 'tmr26-abc123' },
				body: JSON.stringify(body)
			});

		it('writes the selections and membership rows in one transaction', async () => {
			send.mockResolvedValue({});
			const { handler } = await loadLambda();

			const res = await handler(
				putEvent({ name: 'Alex', color: '#e74c3c', selections: {} })
			);

			expect(statusOf(res)).toBe(200);
			const items = commandsOfType('TransactWrite')[0]?.input.TransactItems;
			// Three: the selections row, the membership entry, and the rooms-table index row.
			expect(items).toHaveLength(3);
			expect(
				items.find((item: any) => item.Put?.TableName === 'stagehopper-selections').Put.Item
			).toMatchObject({
				roomId: 'tmr26-abc123',
				userId: 'clerk:1234567890',
				name: 'Alex',
				color: '#e74c3c'
			});
			// The room is added to the user's `rooms` map, not a separate membership row.
			const roomUpdate = items.find(
				(item: any) => item.Update?.TableName === 'stagehopper-users'
			).Update;
			expect(roomUpdate.Key).toEqual({ userId: 'clerk:1234567890' });
			expect(roomUpdate.UpdateExpression).toContain('rooms.#rid');
			expect(roomUpdate.ExpressionAttributeNames['#rid']).toBe('tmr26-abc123');
			expect(roomUpdate.ExpressionAttributeValues[':room']).toMatchObject({
				color: '#e74c3c',
				name: 'Alex'
			});
			expect(typeof roomUpdate.ExpressionAttributeValues[':room'].updatedAt).toBe('number');
		});

		const roomsIndexOf = (items: any[]) =>
			items.find((item: any) => item.Update?.TableName === 'stagehopper-rooms')?.Update;

		// The room has to be indexed against its festival here and not only in `registerRoom`:
		// a typed join code or a shared /room/{id} link never calls that route at all, and an
		// unindexed room reads to the re-import gate as "no rooms" — the failure that loses picks.
		it('indexes the room against its festival in the same transaction', async () => {
			send.mockResolvedValue({});
			const { handler } = await loadLambda();

			await handler(putEvent({ name: 'Alex', color: '#e74c3c', selections: {} }));

			const index = roomsIndexOf(commandsOfType('TransactWrite')[0]?.input.TransactItems);
			expect(index.Key).toEqual({ roomId: 'tmr26-abc123' });
			expect(index.ExpressionAttributeValues[':fid']).toBe('tmr26');
			// First writer decides — re-saving picks must never rewrite the row.
			expect(index.UpdateExpression).toContain('if_not_exists(festivalId');
			expect(index.UpdateExpression).toContain('if_not_exists(createdAt');
		});

		// A claim can be forged; the prefix cannot. Trusting the claim would let any signed-in
		// user pin an unrelated festival's re-import shut by naming it from their own room.
		it('prefers the room id prefix over a festivalId the client claims', async () => {
			send.mockResolvedValue({});
			const { handler } = await loadLambda();

			await handler(
				putEvent({ name: 'Alex', color: '#e74c3c', selections: {}, festivalId: 'ps26' })
			);

			const index = roomsIndexOf(commandsOfType('TransactWrite')[0]?.input.TransactItems);
			expect(index.ExpressionAttributeValues[':fid']).toBe('tmr26');
		});

		it('indexes a custom-slug room from the festivalId the client sends', async () => {
			send.mockResolvedValue({});
			const { handler } = await loadLambda();

			await handler(
				event({
					routeKey: 'PUT /api/stagehopper/rooms/{roomId}/selections',
					pathParameters: { roomId: 'weekend-crew' },
					body: JSON.stringify({
						name: 'Alex',
						color: '#e74c3c',
						selections: {},
						festivalId: 'tmr26'
					})
				})
			);

			const index = roomsIndexOf(commandsOfType('TransactWrite')[0]?.input.TransactItems);
			expect(index.Key).toEqual({ roomId: 'weekend-crew' });
			expect(index.ExpressionAttributeValues[':fid']).toBe('tmr26');
		});

		// The service worker keeps the previous bundle in play for a load or two after a deploy,
		// and that bundle sends no festivalId. Rejecting it would stop real people saving picks
		// to buy a gate that, for a slug room, has nothing to go on anyway.
		it('still saves the picks of a slug room that sends no festivalId at all', async () => {
			send.mockResolvedValue({});
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'PUT /api/stagehopper/rooms/{roomId}/selections',
					pathParameters: { roomId: 'weekend-crew' },
					body: JSON.stringify({ name: 'Alex', color: '#e74c3c', selections: {} })
				})
			);

			expect(statusOf(res)).toBe(200);
			const items = commandsOfType('TransactWrite')[0]?.input.TransactItems;
			expect(items).toHaveLength(2);
			expect(roomsIndexOf(items)).toBeUndefined();
		});

		// A prefixed room needs no claim: the prefix is the festival id.
		it('indexes a prefixed room even when no festivalId is sent', async () => {
			send.mockResolvedValue({});
			const { handler } = await loadLambda();

			await handler(putEvent({ name: 'Alex', color: '#e74c3c', selections: {} }));

			const index = roomsIndexOf(commandsOfType('TransactWrite')[0]?.input.TransactItems);
			expect(index.ExpressionAttributeValues[':fid']).toBe('tmr26');
		});

		it('captures the verified email on the user row for the admin user list', async () => {
			send.mockResolvedValue({});
			const { handler } = await loadLambda();

			await handler(putEvent({ name: 'Alex', color: '#e74c3c', selections: {} }));

			// The identity refresh (email lowercased, the same normalization the admin gate uses)
			// lands on the standalone user-row Update that also ensures the `rooms` map exists.
			const ensure = commandsOfType('Update').find(
				(c) => c.input.TableName === 'stagehopper-users'
			);
			expect(ensure?.input.ExpressionAttributeValues[':email']).toBe('alex@example.com');
		});

		it('stores the verified identity, not a client-claimed user id', async () => {
			send.mockResolvedValue({});
			const { handler } = await loadLambda();

			await handler(
				putEvent({
					name: 'Alex',
					color: '#e74c3c',
					selections: {},
					userId: 'clerk:someone-else'
				})
			);

			const items = commandsOfType('TransactWrite')[0]?.input.TransactItems;
			expect(items[0].Put.Item.userId).toBe('clerk:1234567890');
		});

		it('refuses a write when neither the body nor the token supplies a name', async () => {
			const { handler } = await loadLambda();

			const res = await handler(
				event(
					{
						routeKey: 'PUT /api/stagehopper/rooms/{roomId}/selections',
						pathParameters: { roomId: 'tmr26-abc123' },
						body: JSON.stringify({ color: '#e74c3c', selections: {} })
					},
					{ sub: '1234567890', scope: 'user' }
				)
			);

			expect(statusOf(res)).toBe(400);
			expect(send).not.toHaveBeenCalled();
		});

		it('rejects a write to an invalid room id', async () => {
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'PUT /api/stagehopper/rooms/{roomId}/selections',
					pathParameters: { roomId: '!!' },
					body: JSON.stringify({ color: '#e74c3c', selections: {} })
				})
			);

			expect(statusOf(res)).toBe(400);
		});
	});

	describe('listing rooms', () => {
		it("upserts the user row and lists their rooms sorted by most recently active", async () => {
			send.mockResolvedValue({
				Attributes: {
					userId: 'clerk:1234567890',
					rooms: {
						'tmr26-aaa111': { color: '#111', updatedAt: 5, name: 'Al' },
						'tmr26-bbb222': { color: '#222', updatedAt: 10, name: 'Al' }
					}
				}
			});
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'GET /api/stagehopper/users/me/rooms',
					body: JSON.stringify({})
				})
			);

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual([
				{ roomId: 'tmr26-bbb222', name: 'Al', color: '#222', updatedAt: 10 },
				{ roomId: 'tmr26-aaa111', name: 'Al', color: '#111', updatedAt: 5 }
			]);
			const update = commandsOfType('Update')[0];
			expect(update?.input.TableName).toBe('stagehopper-users');
			expect(update?.input.Key).toEqual({ userId: 'clerk:1234567890' });
			expect(update?.input.ReturnValues).toBe('ALL_NEW');
		});

		it('creates a row on first login with empty rooms and notifications off', async () => {
			send.mockResolvedValue({ Attributes: { userId: 'clerk:1234567890', rooms: {} } });
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'GET /api/stagehopper/users/me/rooms',
					body: JSON.stringify({})
				})
			);

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual([]);
			const update = commandsOfType('Update')[0];
			// Existing data is never clobbered — every field but identity/lastActive is if_not_exists.
			expect(update?.input.UpdateExpression).toContain('rooms = if_not_exists(rooms, :empty)');
			expect(update?.input.UpdateExpression).toContain('enabled = if_not_exists(enabled, :false)');
			expect(update?.input.UpdateExpression).toContain(
				'notifyOverrides = if_not_exists(notifyOverrides, :empty)'
			);
			expect(update?.input.ExpressionAttributeValues[':empty']).toEqual({});
			expect(update?.input.ExpressionAttributeValues[':false']).toBe(false);
			expect(update?.input.ExpressionAttributeValues[':maybe']).toBe(false);
		});

		it('lists rooms even when the Clerk token has no name claim', async () => {
			send.mockResolvedValue({ Attributes: { userId: 'clerk:1234567890', rooms: {} } });
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'GET /api/stagehopper/users/me/rooms',
					body: JSON.stringify({})
				})
			);

			expect(statusOf(res)).toBe(200);
		});

	});

	describe('leaving a room', () => {
		it('deletes both the selections and membership rows in one atomic transaction', async () => {
			send.mockResolvedValue({});
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'DELETE /api/stagehopper/rooms/{roomId}/selections',
					pathParameters: { roomId: 'tmr26-abc123' },
					body: JSON.stringify({})
				})
			);

			expect(statusOf(res)).toBe(200);
			const items = commandsOfType('TransactWrite')[0]?.input.TransactItems;
			expect(items).toHaveLength(2);
			expect(items).toContainEqual({
				Delete: {
					TableName: 'stagehopper-selections',
					Key: { roomId: 'tmr26-abc123', userId: 'clerk:1234567890' }
				}
			});
			// The room is dropped from the user's `rooms` map, not a separate membership row.
			const roomRemove = items.find((item: any) => item.Update?.TableName === 'stagehopper-users').Update;
			expect(roomRemove.Key).toEqual({ userId: 'clerk:1234567890' });
			expect(roomRemove.UpdateExpression).toBe('REMOVE rooms.#rid');
			expect(roomRemove.ExpressionAttributeNames['#rid']).toBe('tmr26-abc123');
		});

		it('leaves a room even when the Clerk token has no name claim', async () => {
			send.mockResolvedValue({});
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'DELETE /api/stagehopper/rooms/{roomId}/selections',
					pathParameters: { roomId: 'tmr26-abc123' },
					body: JSON.stringify({})
				})
			);

			expect(statusOf(res)).toBe(200);
		});

		const leaveEvent = (roomId = 'tmr26-abc123') =>
			event({
				routeKey: 'DELETE /api/stagehopper/rooms/{roomId}/selections',
				pathParameters: { roomId },
				body: JSON.stringify({})
			});

		// An emptied room that kept its index row would block its festival from ever being
		// re-imported, over picks that no longer exist.
		it('forgets the room once its last participant has left', async () => {
			// The membership Query runs after the delete, so it sees nobody left.
			send.mockImplementation((command: MockCommand) =>
				command.__command === 'Query' ? Promise.resolve({ Items: [] }) : Promise.resolve({})
			);
			const { handler } = await loadLambda();

			expect(statusOf(await handler(leaveEvent()))).toBe(200);

			const deletes = commandsOfType('Delete');
			expect(deletes).toHaveLength(1);
			expect(deletes[0]!.input.TableName).toBe('stagehopper-rooms');
			expect(deletes[0]!.input.Key).toEqual({ roomId: 'tmr26-abc123' });
		});

		it('keeps the room indexed while anyone else is still in it', async () => {
			send.mockImplementation((command: MockCommand) =>
				command.__command === 'Query'
					? Promise.resolve({ Items: [{ userId: 'clerk:9999999999' }] })
					: Promise.resolve({})
			);
			const { handler } = await loadLambda();

			expect(statusOf(await handler(leaveEvent()))).toBe(200);

			expect(commandsOfType('Delete')).toHaveLength(0);
		});

		// The `@room` row is the room's display name, not a member — a named room would
		// otherwise read as occupied for ever and never release its festival.
		it('does not count the display-name row as a remaining participant', async () => {
			send.mockImplementation((command: MockCommand) =>
				command.__command === 'Query'
					? Promise.resolve({ Items: [{ userId: '@room' }] })
					: Promise.resolve({})
			);
			const { handler } = await loadLambda();

			await handler(leaveEvent());

			expect(commandsOfType('Delete')).toHaveLength(1);
			expect(commandsOfType('Delete')[0]!.input.TableName).toBe('stagehopper-rooms');
		});

		// Bookkeeping must never turn into a failed leave.
		it('still reports success when forgetting the room fails', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			send.mockImplementation((command: MockCommand) =>
				command.__command === 'Query'
					? Promise.reject(new Error('access denied'))
					: Promise.resolve({})
			);
			const { handler } = await loadLambda();

			expect(statusOf(await handler(leaveEvent()))).toBe(200);
			consoleError.mockRestore();
		});

		it('rejects leaving a room with an invalid roomId', async () => {
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'DELETE /api/stagehopper/rooms/{roomId}/selections',
					pathParameters: { roomId: '!!' },
					body: JSON.stringify({})
				})
			);

			expect(statusOf(res)).toBe(400);
		});

	});
});

describe('GET /admin/me', () => {
	beforeEach(() => {
		vi.resetModules();
		send.mockReset();
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
	});

	afterEach(() => {
		delete process.env.SITE_ORIGIN;
	});

	async function adminMe(claims: Record<string, unknown> | null = USER_CLAIMS) {
		const { handler } = await loadLambda();
		return handler(event({ routeKey: 'GET /api/stagehopper/admin/me' }, claims));
	}

	it('admits a caller carrying the admin scope', async () => {
		const res = await adminMe(ADMIN_CLAIMS);

		expect(statusOf(res)).toBe(200);
		expect(bodyOf(res)).toEqual({ isAdmin: true });
	});

	// 403 rather than 401: the session is valid, so the client has nothing to re-authenticate
	// into and would otherwise loop through sign-in forever.
	it('answers 403, not 401, for a signed-in caller without the scope', async () => {
		const res = await adminMe();

		expect(statusOf(res)).toBe(403);
		expect(bodyOf(res)).toMatchObject({ isAdmin: false });
	});

	// This is deliberately the one /admin/* route with no `authorization_scopes` in Terraform:
	// a gateway 403 cannot say "signed in, but not an admin", which is the only thing this
	// route exists to say.
	it('answers 401 when no claims reached the Lambda at all', async () => {
		expect(statusOf(await adminMe(null))).toBe(401);
	});

	it('reads no data to answer', async () => {
		await adminMe(ADMIN_CLAIMS);

		expect(send).not.toHaveBeenCalled();
	});
});

describe('fail-closed guard', () => {
	beforeEach(() => {
		vi.resetModules();
		send.mockReset().mockResolvedValue({});
		process.env.TABLE_NAME = 'stagehopper-selections';
		process.env.USERS_TABLE = 'stagehopper-users';
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
	});

	afterEach(() => {
		delete process.env.TABLE_NAME;
		delete process.env.USERS_TABLE;
		delete process.env.SITE_ORIGIN;
	});

	// API Gateway rejects an unauthenticated request before invoking this function, so none
	// of these are reachable in production. They are here because the failure mode if a
	// route is ever declared without `authorizer_id` is silent and severe: the handler would
	// write under `clerk:undefined` and hand one shared identity to every anonymous caller.
	// Answering 401 instead is what makes that misconfiguration visible rather than corrupting.
	const ROUTES: [string, Partial<APIGatewayProxyEventV2>][] = [
		['PUT /api/stagehopper/rooms/{roomId}/selections', {
			pathParameters: { roomId: 'tmr26-abc123' },
			body: JSON.stringify({ name: 'Alex', color: '#e74c3c', selections: {} })
		}],
		['DELETE /api/stagehopper/rooms/{roomId}/selections', {
			pathParameters: { roomId: 'tmr26-abc123' }
		}],
		['GET /api/stagehopper/users/me/rooms', {}],
		['GET /api/stagehopper/admin/me', {}],
		['POST /api/stagehopper/users/me/notifications', { body: '{}' }],
		['POST /api/stagehopper/admin/rooms', { body: '{}' }],
		['POST /api/stagehopper/admin/users', { body: '{}' }]
	];

	it.each(ROUTES)('answers 401 on %s when no claims are attached', async (routeKey, rest) => {
		const { handler } = await loadLambda();

		const res = await handler(event({ routeKey, ...rest }, null));

		expect(statusOf(res)).toBe(401);
		expect(send).not.toHaveBeenCalled();
	});

	// The one route that must keep working without any credential at all.
	it('still serves the public selections read with no claims', async () => {
		send.mockResolvedValue({ Items: [] });
		const { handler } = await loadLambda();

		const res = await handler(
			event(
				{
					routeKey: 'GET /api/stagehopper/rooms/{roomId}/selections',
					pathParameters: { roomId: 'tmr26-abc123' }
				},
				null
			)
		);

		expect(statusOf(res)).toBe(200);
	});
});

describe('user: notifications', () => {
	beforeEach(() => {
		vi.resetModules();
		send.mockReset().mockResolvedValue({});
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
		process.env.USERS_TABLE = 'stagehopper-users';
		process.env.PUSH_SUBSCRIPTIONS_TABLE = 'stagehopper-push-subscriptions';
	});

	afterEach(() => {
		delete process.env.SITE_ORIGIN;
		delete process.env.USERS_TABLE;
		delete process.env.PUSH_SUBSCRIPTIONS_TABLE;
	});

	function notify(routeKey: string, body: unknown) {
		return event({ routeKey, body: JSON.stringify(body) });
	}

	describe('POST .../notifications (read)', () => {
		it('returns defaults with enabled=false when the user has no rows', async () => {
			send
				.mockResolvedValueOnce({}) // Get settings: no item
				.mockResolvedValueOnce({ Items: [] }); // Query subscriptions
			const { handler } = await loadLambda();

			const res = await handler(
				notify('POST /api/stagehopper/users/me/notifications', {})
			);

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({
				leadMinutes: 15,
				notifyMaybe: false,
				notifyOverrides: {},
				enabled: false,
				subscribedHere: false
			});
		});

		it('reflects stored settings and marks subscribedHere for a matching endpoint', async () => {
			send
				.mockResolvedValueOnce({
					Item: {
						leadMinutes: 20,
						notifyMaybe: false,
						notifyOverrides: { perf1: true, perf2: false }
					}
				})
				.mockResolvedValueOnce({ Items: [{ endpoint: 'https://push/abc' }] });
			const { handler } = await loadLambda();

			const res = await handler(
				notify('POST /api/stagehopper/users/me/notifications', {
					endpoint: 'https://push/abc'
				})
			);

			expect(bodyOf(res)).toEqual({
				leadMinutes: 20,
				notifyMaybe: false,
				notifyOverrides: { perf1: true, perf2: false },
				enabled: true,
				subscribedHere: true
			});
		});

	});

	describe('PUT .../notifications (write settings)', () => {
		it('rejects a leadMinutes outside the preset set', async () => {
			const { handler } = await loadLambda();
			const res = await handler(
				notify('PUT /api/stagehopper/users/me/notifications', {
					leadMinutes: 7,
					notifyMaybe: false
				})
			);
			expect(statusOf(res)).toBe(400);
			expect(bodyOf(res).error).toMatch(/leadMinutes/);
		});

		it('rejects a non-boolean notifyMaybe', async () => {
			const { handler } = await loadLambda();
			const res = await handler(
				notify('PUT /api/stagehopper/users/me/notifications', {
					leadMinutes: 15,
					notifyMaybe: 'yes'
				})
			);
			expect(statusOf(res)).toBe(400);
		});

		it('rejects an empty body — neither settings nor overrides', async () => {
			const { handler } = await loadLambda();
			const res = await handler(notify('PUT /api/stagehopper/users/me/notifications', {}));
			expect(statusOf(res)).toBe(400);
		});

		it('rejects leadMinutes without notifyMaybe — the settings pair is all-or-nothing', async () => {
			const { handler } = await loadLambda();
			const res = await handler(
				notify('PUT /api/stagehopper/users/me/notifications', {
					leadMinutes: 15
				})
			);
			expect(statusOf(res)).toBe(400);
			expect(bodyOf(res).error).toMatch(/notifyMaybe/);
		});

		it('rejects notifyMaybe without leadMinutes — the settings pair is all-or-nothing', async () => {
			const { handler } = await loadLambda();
			const res = await handler(
				notify('PUT /api/stagehopper/users/me/notifications', {
					notifyMaybe: true
				})
			);
			expect(statusOf(res)).toBe(400);
			expect(bodyOf(res).error).toMatch(/leadMinutes/);
		});

		it('rejects an empty notifyOverrides patch rather than issuing a no-op write', async () => {
			const { handler } = await loadLambda();
			const res = await handler(
				notify('PUT /api/stagehopper/users/me/notifications', {
					notifyOverrides: {}
				})
			);
			expect(statusOf(res)).toBe(400);
			expect(bodyOf(res).error).toMatch(/notifyOverrides/);
			// Never reaches DynamoDB with a blank UpdateExpression.
			expect(commandsOfType('Update')).toHaveLength(0);
		});

		it('upserts settings for a valid body without touching subscriptions', async () => {
			const { handler } = await loadLambda();
			const res = await handler(
				notify('PUT /api/stagehopper/users/me/notifications', {
					leadMinutes: 30,
					notifyMaybe: true
				})
			);

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({ leadMinutes: 30, notifyMaybe: true, ok: true });
			const update = commandsOfType('Update')[0];
			expect(update?.input.TableName).toBe('stagehopper-users');
			expect(update?.input.Key).toEqual({ userId: 'clerk:1234567890' });
			expect(update?.input.UpdateExpression).toBe('SET leadMinutes = :lead, notifyMaybe = :maybe');
			expect(update?.input.ExpressionAttributeValues).toEqual({ ':lead': 30, ':maybe': true });
		});

		it('sets a per-performance override without requiring leadMinutes/notifyMaybe', async () => {
			const { handler } = await loadLambda();
			const res = await handler(
				notify('PUT /api/stagehopper/users/me/notifications', {
					notifyOverrides: { perf1: false }
				})
			);

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({ ok: true });
			const update = commandsOfType('Update')[0];
			expect(update?.input.UpdateExpression).toBe('SET notifyOverrides.#o0 = :o0');
			expect(update?.input.ExpressionAttributeNames).toEqual({ '#o0': 'perf1' });
			expect(update?.input.ExpressionAttributeValues).toEqual({ ':o0': false });
		});

		it('removes a per-performance override when the patch value is null', async () => {
			const { handler } = await loadLambda();
			const res = await handler(
				notify('PUT /api/stagehopper/users/me/notifications', {
					notifyOverrides: { perf1: null }
				})
			);

			expect(statusOf(res)).toBe(200);
			const update = commandsOfType('Update')[0];
			expect(update?.input.UpdateExpression).toBe('REMOVE notifyOverrides.#o0');
			expect(update?.input.ExpressionAttributeNames).toEqual({ '#o0': 'perf1' });
			expect(update?.input.ExpressionAttributeValues).toBeUndefined();
		});

		it('applies settings and an override patch in one call', async () => {
			const { handler } = await loadLambda();
			const res = await handler(
				notify('PUT /api/stagehopper/users/me/notifications', {
					leadMinutes: 20,
					notifyMaybe: false,
					notifyOverrides: { perf1: true, perf2: null }
				})
			);

			expect(statusOf(res)).toBe(200);
			const update = commandsOfType('Update')[0];
			expect(update?.input.UpdateExpression).toBe(
				'SET leadMinutes = :lead, notifyMaybe = :maybe, notifyOverrides.#o0 = :o0 REMOVE notifyOverrides.#o1'
			);
			expect(update?.input.ExpressionAttributeNames).toEqual({ '#o0': 'perf1', '#o1': 'perf2' });
		});

		it('sets multiple overrides at once — a true, a false, and a removal in the same patch', async () => {
			const { handler } = await loadLambda();
			const res = await handler(
				notify('PUT /api/stagehopper/users/me/notifications', {
					notifyOverrides: { perf1: true, perf2: false, perf3: null }
				})
			);

			expect(statusOf(res)).toBe(200);
			const update = commandsOfType('Update')[0];
			expect(update?.input.UpdateExpression).toBe(
				'SET notifyOverrides.#o0 = :o0, notifyOverrides.#o1 = :o1 REMOVE notifyOverrides.#o2'
			);
			expect(update?.input.ExpressionAttributeNames).toEqual({
				'#o0': 'perf1',
				'#o1': 'perf2',
				'#o2': 'perf3'
			});
			expect(update?.input.ExpressionAttributeValues).toEqual({ ':o0': true, ':o1': false });
		});

		it('rejects a notifyOverrides value that is neither boolean nor null', async () => {
			const { handler } = await loadLambda();
			const res = await handler(
				notify('PUT /api/stagehopper/users/me/notifications', {
					notifyOverrides: { perf1: 'yes' }
				})
			);
			expect(statusOf(res)).toBe(400);
			expect(bodyOf(res).error).toMatch(/notifyOverrides/);
		});

		it('rejects a non-object notifyOverrides', async () => {
			const { handler } = await loadLambda();
			const res = await handler(
				notify('PUT /api/stagehopper/users/me/notifications', {
					notifyOverrides: 'perf1'
				})
			);
			expect(statusOf(res)).toBe(400);
		});
	});

	describe('POST .../notifications/subscription (add device)', () => {
		it('stores the subscription and flips enabled true', async () => {
			const { handler } = await loadLambda();
			const res = await handler(
				notify('POST /api/stagehopper/users/me/notifications/subscription', {
					subscription: { endpoint: 'https://push/abc', keys: { p256dh: 'p', auth: 'a' } }
				})
			);

			expect(statusOf(res)).toBe(200);
			const put = commandsOfType('Put')[0];
			expect(put?.input.TableName).toBe('stagehopper-push-subscriptions');
			expect(put?.input.Item).toMatchObject({
				userId: 'clerk:1234567890',
				endpoint: 'https://push/abc',
				keys: { p256dh: 'p', auth: 'a' }
			});
			const update = commandsOfType('Update')[0];
			expect(update?.input.ExpressionAttributeValues).toMatchObject({ ':true': true });
		});

		it('rejects a subscription missing its keys', async () => {
			const { handler } = await loadLambda();
			const res = await handler(
				notify('POST /api/stagehopper/users/me/notifications/subscription', {
					subscription: { endpoint: 'https://push/abc' }
				})
			);
			expect(statusOf(res)).toBe(400);
		});
	});

	describe('DELETE .../notifications/subscription (remove device)', () => {
		it('sets enabled false when the last device is removed', async () => {
			send
				.mockResolvedValueOnce({}) // Delete
				.mockResolvedValueOnce({ Items: [] }); // Query remaining: none
			const { handler } = await loadLambda();

			const res = await handler(
				notify('DELETE /api/stagehopper/users/me/notifications/subscription', {
					endpoint: 'https://push/abc'
				})
			);

			expect(statusOf(res)).toBe(200);
			const update = commandsOfType('Update')[0];
			expect(update?.input.ExpressionAttributeValues).toEqual({ ':false': false });
		});

		it('leaves enabled untouched when other devices remain', async () => {
			send
				.mockResolvedValueOnce({}) // Delete
				.mockResolvedValueOnce({ Items: [{ endpoint: 'https://push/other' }] }); // remaining
			const { handler } = await loadLambda();

			const res = await handler(
				notify('DELETE /api/stagehopper/users/me/notifications/subscription', {
					endpoint: 'https://push/abc'
				})
			);

			expect(statusOf(res)).toBe(200);
			expect(commandsOfType('Update')).toHaveLength(0);
		});

		it('rejects a delete without an endpoint', async () => {
			const { handler } = await loadLambda();
			const res = await handler(
				notify('DELETE /api/stagehopper/users/me/notifications/subscription', {})
			);
			expect(statusOf(res)).toBe(400);
		});
	});
});

describe('admin: festivals', () => {
	function validRecord(overrides: Record<string, unknown> = {}) {
		return {
			id: 'newfest26',
			name: 'New Fest 2026',
			location: 'Testville',
			startDate: '2026-08-01',
			endDate: '2026-08-03',
			timezone: 'Europe/Berlin',
			...overrides
		};
	}

	beforeEach(() => {
		vi.resetModules();
		send.mockReset().mockResolvedValue({});
		s3Send.mockReset().mockResolvedValue({});
		cloudfrontSend.mockReset().mockResolvedValue({});
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
		process.env.SITE_BUCKET = 'stagehopper-radomskyi-com';
		process.env.CF_DISTRIBUTION_ID = 'EDFDVBD6EXAMPLE';
		process.env.FESTIVALS_TABLE = 'stagehopper-festivals';
		process.env.PERFORMANCES_TABLE = 'stagehopper-performances';
	});

	afterEach(() => {
		delete process.env.SITE_ORIGIN;
		delete process.env.SITE_BUCKET;
		delete process.env.CF_DISTRIBUTION_ID;
		delete process.env.FESTIVALS_TABLE;
		delete process.env.PERFORMANCES_TABLE;
	});

	async function getFestivalsReq() {
		const { handler } = await loadLambda();
		return handler(event({ routeKey: 'GET /api/stagehopper/admin/festivals' }));
	}

	async function createFestivalReq(body: unknown) {
		const { handler } = await loadLambda();
		return handler(
			event({ routeKey: 'POST /api/stagehopper/admin/festivals', body: JSON.stringify(body) })
		);
	}

	async function updateFestivalReq(festivalId: string, body: unknown) {
		const { handler } = await loadLambda();
		return handler(
			event({
				routeKey: 'PATCH /api/stagehopper/admin/festivals/{id}',
				pathParameters: { id: festivalId },
				body: JSON.stringify(body)
			})
		);
	}

	async function updateStageOrderReq(festivalId: string, body: unknown) {
		const { handler } = await loadLambda();
		return handler(
			event({
				routeKey: 'PATCH /api/stagehopper/admin/festivals/{id}/stage-order',
				pathParameters: { id: festivalId },
				body: JSON.stringify(body)
			})
		);
	}

	async function deleteFestivalReq(festivalId: string) {
		const { handler } = await loadLambda();
		return handler(
			event({
				routeKey: 'DELETE /api/stagehopper/admin/festivals/{id}',
				pathParameters: { id: festivalId }
			})
		);
	}

	// The deploy workflow's direct invoke: no API Gateway, no routeKey, no authorizer. It
	// exists so a release that changes the manifest's shape republishes it immediately,
	// instead of waiting for an unrelated admin edit to happen to rewrite the file.
	describe('direct invoke: republish festivals-manifest', () => {
		async function republishInvoke() {
			const { handler } = await loadLambda();
			return handler({ republish: 'festivals-manifest' } as never);
		}

		it('rebuilds the manifest from the table and reports ok', async () => {
			send.mockImplementation((command: MockCommand) =>
				command.__command === 'Scan'
					? Promise.resolve({ Items: [validRecord({ description: 'Beach music.' })] })
					: Promise.resolve({})
			);

			const res = await republishInvoke();

			expect(res).toEqual({ ok: true, key: 'data/festivals/index.json' });
			const [manifestCommand] = s3Send.mock.calls[0] as [{ input: { Key: string; Body: string } }];
			expect(manifestCommand.input.Key).toBe('data/festivals/index.json');
			expect(JSON.parse(manifestCommand.input.Body)).toEqual([
				{
					id: 'newfest26',
					name: 'New Fest 2026',
					location: 'Testville',
					startDate: '2026-08-01',
					endDate: '2026-08-03',
					timezone: 'Europe/Berlin',
					description: 'Beach music.'
				}
			]);
		});

		// The deploy step keys off `ok`, so a failure has to come back as data rather than a
		// thrown error — a thrown one invokes fine and only shows up as a FunctionError.
		it('reports ok: false rather than throwing when the publish fails', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			s3Send.mockRejectedValue(new Error('access denied'));

			const res = await republishInvoke();

			expect(res).toMatchObject({ ok: false, key: 'data/festivals/index.json' });
			consoleError.mockRestore();
		});

		// Every gateway event carries a routeKey, so a request can never reach the
		// maintenance path by putting `republish` in its body or query string.
		it('ignores the field on an event that carries a routeKey', async () => {
			send.mockImplementation((command: MockCommand) =>
				command.__command === 'Scan'
					? Promise.resolve({ Items: [validRecord()] })
					: Promise.resolve({})
			);
			const { handler } = await loadLambda();

			const res = await handler({
				...event({ routeKey: 'GET /api/stagehopper/admin/festivals' }),
				republish: 'festivals-manifest'
			} as never);

			expect(statusOf(res)).toBe(200);
			expect(s3Send).not.toHaveBeenCalled();
		});
	});

	describe('GET /admin/festivals', () => {
		it('returns every festival from a table scan', async () => {
			send.mockImplementation((command: MockCommand) =>
				command.__command === 'Scan'
					? Promise.resolve({ Items: [validRecord()] })
					: Promise.resolve({})
			);

			const res = await getFestivalsReq();

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({ festivals: [validRecord()] });
		});

		it('answers 500 when the scan fails', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			send.mockRejectedValue(new Error('access denied'));

			const res = await getFestivalsReq();

			expect(statusOf(res)).toBe(500);
			consoleError.mockRestore();
		});
	});

	describe('POST /admin/festivals (create)', () => {
		it('writes the festival and republishes the manifest', async () => {
			send.mockImplementation((command: MockCommand) => {
				if (command.__command === 'Scan') return Promise.resolve({ Items: [validRecord()] });
				return Promise.resolve({});
			});

			const res = await createFestivalReq(validRecord());

			expect(statusOf(res)).toBe(201);
			expect(bodyOf(res)).toEqual({ ok: true, festival: validRecord(), published: true });

			const putCommand = commandsOfType('Put')[0]!;
			expect(putCommand.input).toMatchObject({
				TableName: 'stagehopper-festivals',
				Item: validRecord(),
				ConditionExpression: 'attribute_not_exists(id)'
			});

			const [manifestCommand] = s3Send.mock.calls[0] as [
				{ input: { Bucket: string; Key: string; Body: string; ContentType: string } }
			];
			expect(manifestCommand.input).toMatchObject({
				Bucket: 'stagehopper-radomskyi-com',
				Key: 'data/festivals/index.json',
				ContentType: 'application/json'
			});
			expect(JSON.parse(manifestCommand.input.Body)).toEqual([
				{
					id: 'newfest26',
					name: 'New Fest 2026',
					location: 'Testville',
					startDate: '2026-08-01',
					endDate: '2026-08-03',
					timezone: 'Europe/Berlin'
				}
			]);

			const [invalidateCommand] = cloudfrontSend.mock.calls[0] as [
				{ input: { DistributionId: string; InvalidationBatch: { Paths: { Items: string[] } } } }
			];
			expect(invalidateCommand.input.DistributionId).toBe('EDFDVBD6EXAMPLE');
			expect(invalidateCommand.input.InvalidationBatch.Paths.Items).toEqual([
				'/data/festivals/index.json'
			]);
		});

		it('republishes description in the manifest when the record has one', async () => {
			const record = validRecord({ description: 'Three days of music on the beach.' });
			send.mockImplementation((command: MockCommand) => {
				if (command.__command === 'Scan') return Promise.resolve({ Items: [record] });
				return Promise.resolve({});
			});

			const res = await createFestivalReq(record);

			expect(statusOf(res)).toBe(201);
			const [manifestCommand] = s3Send.mock.calls[0] as [{ input: { Body: string } }];
			expect(JSON.parse(manifestCommand.input.Body)).toEqual([
				{
					id: 'newfest26',
					name: 'New Fest 2026',
					location: 'Testville',
					startDate: '2026-08-01',
					endDate: '2026-08-03',
					timezone: 'Europe/Berlin',
					description: 'Three days of music on the beach.'
				}
			]);
		});

		// The room page's Map menu entry reads this off the manifest, so leaving it out made
		// every uploaded map invisible to visitors while still previewing fine in the admin.
		it('republishes mapUrl in the manifest when the record has one', async () => {
			const record = validRecord({ mapUrl: '/data/festival-maps/newfest26-abc123.jpg' });
			send.mockImplementation((command: MockCommand) => {
				if (command.__command === 'Scan') return Promise.resolve({ Items: [record] });
				return Promise.resolve({});
			});

			const res = await createFestivalReq(record);

			expect(statusOf(res)).toBe(201);
			const [manifestCommand] = s3Send.mock.calls[0] as [{ input: { Body: string } }];
			expect(JSON.parse(manifestCommand.input.Body)).toEqual([
				{
					id: 'newfest26',
					name: 'New Fest 2026',
					location: 'Testville',
					startDate: '2026-08-01',
					endDate: '2026-08-03',
					timezone: 'Europe/Berlin',
					mapUrl: '/data/festival-maps/newfest26-abc123.jpg'
				}
			]);
		});

		it('republishes stageColors in the manifest when the record has them', async () => {
			const record = validRecord({ stageColors: { 'Main Stage': '#3498db' } });
			send.mockImplementation((command: MockCommand) => {
				if (command.__command === 'Scan') return Promise.resolve({ Items: [record] });
				return Promise.resolve({});
			});

			const res = await createFestivalReq(record);

			expect(statusOf(res)).toBe(201);
			const [manifestCommand] = s3Send.mock.calls[0] as [{ input: { Body: string } }];
			expect(JSON.parse(manifestCommand.input.Body)).toEqual([
				{
					id: 'newfest26',
					name: 'New Fest 2026',
					location: 'Testville',
					startDate: '2026-08-01',
					endDate: '2026-08-03',
					timezone: 'Europe/Berlin',
					stageColors: { 'Main Stage': '#3498db' }
				}
			]);
		});

		it.each([
			['an id that is too long', validRecord({ id: 'x'.repeat(11) }), /festival id/i],
			['an id with uppercase letters', validRecord({ id: 'NewFest26' }), /festival id/i],
			['a blank name', validRecord({ name: '  ' }), /name is required/i],
			['a malformed startDate', validRecord({ startDate: '08/01/2026' }), /startDate/],
			[
				'an endDate before the startDate',
				validRecord({ startDate: '2026-08-10', endDate: '2026-08-01' }),
				/startDate must not be after endDate/i
			],
			['a missing timezone', validRecord({ timezone: undefined }), /timezone/i],
			['a non-string imageUrl', validRecord({ imageUrl: 5 }), /imageUrl must be a string/i],
			['a non-string mapUrl', validRecord({ mapUrl: true }), /mapUrl must be a string/i],
			['a non-string description', validRecord({ description: 5 }), /description must be a string/i],
			[
				'a description over 1000 characters',
				validRecord({ description: 'x'.repeat(1001) }),
				/description must be at most 1000 characters/i
			],
			['a non-object stageColors', validRecord({ stageColors: 'red' }), /stageColors must be an object/i],
			['an array stageColors', validRecord({ stageColors: ['#e74c3c'] }), /stageColors must be an object/i],
			[
				'a non-hex stageColors value',
				validRecord({ stageColors: { 'Main Stage': 'red' } }),
				/stageColors\["Main Stage"\] must be a #rrggbb colour/i
			],
			['a non-array stageOrder', validRecord({ stageOrder: 'Main Stage' }), /stageOrder must be an array/i],
			[
				'a stageOrder with a blank entry',
				validRecord({ stageOrder: ['Main Stage', ''] }),
				/stageOrder must be an array of non-empty strings/i
			]
		])('rejects %s before writing anything', async (_label, body, expected) => {
			const res = await createFestivalReq(body);

			expect(statusOf(res)).toBe(400);
			expect(bodyOf(res).error).toMatch(expected);
			expect(send).not.toHaveBeenCalled();
			expect(s3Send).not.toHaveBeenCalled();
		});

		it('answers 409 when the id is already taken', async () => {
			send.mockImplementation((command: MockCommand) =>
				command.__command === 'Put'
					? Promise.reject(Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' }))
					: Promise.resolve({})
			);

			const res = await createFestivalReq(validRecord());

			expect(statusOf(res)).toBe(409);
			expect(s3Send).not.toHaveBeenCalled();
		});

		it('answers 500 when the write fails for another reason', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			send.mockRejectedValue(new Error('access denied'));

			const res = await createFestivalReq(validRecord());

			expect(statusOf(res)).toBe(500);
			consoleError.mockRestore();
		});

		it('still reports created when the write lands but republishing the manifest fails', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			send.mockImplementation((command: MockCommand) =>
				command.__command === 'Scan'
					? Promise.reject(new Error('access denied'))
					: Promise.resolve({})
			);

			const res = await createFestivalReq(validRecord());

			expect(statusOf(res)).toBe(201);
			expect(bodyOf(res)).toMatchObject({ ok: true, published: false });
			consoleError.mockRestore();
		});
	});

	describe('PATCH /admin/festivals/{id} (update)', () => {
		it('writes the festival with the id taken from the path, and republishes the manifest', async () => {
			send.mockImplementation((command: MockCommand) => {
				if (command.__command === 'Scan') {
					return Promise.resolve({ Items: [validRecord({ location: 'Updated' })] });
				}
				return Promise.resolve({});
			});

			// The path id wins even if the body somehow disagrees.
			const res = await updateFestivalReq('newfest26', validRecord({ id: 'ignored', location: 'Updated' }));

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({
				ok: true,
				festival: validRecord({ location: 'Updated' }),
				published: true
			});

			const putCommand = commandsOfType('Put')[0]!;
			expect(putCommand.input).toMatchObject({
				TableName: 'stagehopper-festivals',
				Item: validRecord({ location: 'Updated' }),
				ConditionExpression: 'attribute_exists(id)'
			});

			expect(cloudfrontSend).toHaveBeenCalled();
		});

		it('answers 404 when the festival does not exist', async () => {
			send.mockImplementation((command: MockCommand) =>
				command.__command === 'Put'
					? Promise.reject(Object.assign(new Error('missing'), { name: 'ConditionalCheckFailedException' }))
					: Promise.resolve({})
			);

			const res = await updateFestivalReq('newfest26', validRecord());

			expect(statusOf(res)).toBe(404);
		});

		it('rejects a malformed festival id in the path', async () => {
			const res = await updateFestivalReq('Not An Id', validRecord());

			expect(statusOf(res)).toBe(400);
			expect(send).not.toHaveBeenCalled();
		});

		it('rejects an invalid record before writing anything', async () => {
			const res = await updateFestivalReq('newfest26', validRecord({ name: '' }));

			expect(statusOf(res)).toBe(400);
			expect(send).not.toHaveBeenCalled();
		});
	});

	describe('PATCH /admin/festivals/{id}/stage-order', () => {
		it('writes only stageOrder via an UpdateCommand, and republishes the manifest', async () => {
			send.mockImplementation((command: MockCommand) => {
				if (command.__command === 'Scan') {
					return Promise.resolve({ Items: [validRecord({ stageOrder: ['Forest Stage', 'Main Stage'] })] });
				}
				return Promise.resolve({});
			});

			const res = await updateStageOrderReq('newfest26', { stageOrder: ['Forest Stage', 'Main Stage'] });

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({
				ok: true,
				stageOrder: ['Forest Stage', 'Main Stage'],
				published: true
			});

			const update = commandsOfType('Update')[0]!;
			expect(update.input).toMatchObject({
				TableName: 'stagehopper-festivals',
				Key: { id: 'newfest26' },
				ConditionExpression: 'attribute_exists(id)',
				UpdateExpression: 'SET stageOrder = :stageOrder',
				ExpressionAttributeValues: { ':stageOrder': ['Forest Stage', 'Main Stage'] }
			});
			expect(commandsOfType('Put')).toHaveLength(0);

			expect(cloudfrontSend).toHaveBeenCalled();
		});

		it('answers 404 when the festival does not exist', async () => {
			send.mockImplementation((command: MockCommand) =>
				command.__command === 'Update'
					? Promise.reject(Object.assign(new Error('missing'), { name: 'ConditionalCheckFailedException' }))
					: Promise.resolve({})
			);

			const res = await updateStageOrderReq('newfest26', { stageOrder: ['Main Stage'] });

			expect(statusOf(res)).toBe(404);
		});

		it('rejects a malformed festival id in the path', async () => {
			const res = await updateStageOrderReq('Not An Id', { stageOrder: ['Main Stage'] });

			expect(statusOf(res)).toBe(400);
			expect(send).not.toHaveBeenCalled();
		});

		it.each([
			['a missing stageOrder', {}, /stageOrder must be an array/i],
			['a non-array stageOrder', { stageOrder: 'Main Stage' }, /stageOrder must be an array/i],
			['a stageOrder with a non-string entry', { stageOrder: ['Main Stage', 5] }, /non-empty strings/i],
			['a stageOrder with a blank entry', { stageOrder: ['Main Stage', '  '] }, /non-empty strings/i]
		])('rejects %s before writing anything', async (_label, body, expected) => {
			const res = await updateStageOrderReq('newfest26', body);

			expect(statusOf(res)).toBe(400);
			expect(bodyOf(res)).toMatchObject({ error: expect.stringMatching(expected) });
			expect(send).not.toHaveBeenCalled();
		});

		it('answers 500 when the write fails for another reason', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			send.mockRejectedValue(new Error('access denied'));

			const res = await updateStageOrderReq('newfest26', { stageOrder: ['Main Stage'] });

			expect(statusOf(res)).toBe(500);
			consoleError.mockRestore();
		});
	});

	describe('DELETE /admin/festivals/{id}', () => {
		it('deletes the festival, every performance on its timetable, and both public artifacts', async () => {
			send.mockImplementation((command: MockCommand) => {
				if (command.__command === 'Query') {
					return Promise.resolve({ Items: [{ id: 'p1' }, { id: 'p2' }] });
				}
				if (command.__command === 'Scan') return Promise.resolve({ Items: [] });
				return Promise.resolve({});
			});

			const res = await deleteFestivalReq('newfest26');

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({ ok: true, published: true });

			const deleteCommand = commandsOfType('Delete')[0]!;
			expect(deleteCommand.input).toMatchObject({
				TableName: 'stagehopper-festivals',
				Key: { id: 'newfest26' }
			});

			const batchCommand = commandsOfType('BatchWrite')[0]!;
			expect(batchCommand.input.RequestItems['stagehopper-performances']).toEqual([
				{ DeleteRequest: { Key: { festivalId: 'newfest26', id: 'p1' } } },
				{ DeleteRequest: { Key: { festivalId: 'newfest26', id: 'p2' } } }
			]);

			const s3Calls = s3Send.mock.calls.map(([c]) => c as MockCommand);
			expect(s3Calls.some((c) => c.__command === 'PutObject' && c.input.Key === 'data/festivals/index.json')).toBe(
				true
			);
			expect(
				s3Calls.some(
					(c) => c.__command === 'DeleteObject' && c.input.Key === 'data/festivals/newfest26/timetable.json'
				)
			).toBe(true);
		});

		it('rejects a malformed festival id', async () => {
			const res = await deleteFestivalReq('Not An Id');

			expect(statusOf(res)).toBe(400);
			expect(send).not.toHaveBeenCalled();
		});

		it('answers 500 when the delete fails', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			send.mockRejectedValue(new Error('access denied'));

			const res = await deleteFestivalReq('newfest26');

			expect(statusOf(res)).toBe(500);
			consoleError.mockRestore();
		});
	});
});

describe('generalized room id regex', () => {
	beforeEach(() => {
		vi.resetModules();
		send.mockReset().mockResolvedValue({ Items: [] });
		process.env.TABLE_NAME = 'stagehopper-selections';
		process.env.USERS_TABLE = 'stagehopper-users';
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
	});

	afterEach(() => {
		delete process.env.TABLE_NAME;
		delete process.env.USERS_TABLE;
		delete process.env.SITE_ORIGIN;
	});

	it('accepts a room id under a newly admin-created festival prefix', async () => {
		const { handler } = await loadLambda();

		const res = await handler(
			event({
				routeKey: 'GET /api/stagehopper/rooms/{roomId}/selections',
				pathParameters: { roomId: 'newfest26-a1b2c3' }
			})
		);

		expect(statusOf(res)).toBe(200);
	});

	it('still rejects a malformed room id', async () => {
		const { handler } = await loadLambda();

		const res = await handler(
			event({
				routeKey: 'GET /api/stagehopper/rooms/{roomId}/selections',
				pathParameters: { roomId: 'this has spaces' }
			})
		);

		expect(statusOf(res)).toBe(400);
	});

	it('still supports the custom-slug branch', async () => {
		const { handler } = await loadLambda();

		const res = await handler(
			event({
				routeKey: 'GET /api/stagehopper/rooms/{roomId}/selections',
				pathParameters: { roomId: 'our-crew-2026' }
			})
		);

		expect(statusOf(res)).toBe(200);
	});
});

describe('admin: festival image upload', () => {
	beforeEach(() => {
		vi.resetModules();
		s3Send.mockReset();
		getSignedUrl.mockReset().mockResolvedValue('https://s3.example/presigned-put');
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
		process.env.SITE_BUCKET = 'stagehopper-radomskyi-com';
	});

	afterEach(() => {
		delete process.env.SITE_ORIGIN;
		delete process.env.SITE_BUCKET;
	});

	async function presign(
		body: unknown,
		festivalId = 'tmr26',
		overrides: Partial<APIGatewayProxyEventV2> = {}
	) {
		const { handler } = await loadLambda();
		return handler(
			event({
				routeKey: 'POST /api/stagehopper/admin/festivals/{id}/image-upload',
				pathParameters: { id: festivalId },
				body: JSON.stringify(body),
				...overrides
			})
		);
	}

	it('mints a presigned URL for an allowed content type and size', async () => {
		const res = await presign({ contentType: 'image/jpeg', contentLength: 500_000 });

		expect(statusOf(res)).toBe(200);
		expect(bodyOf(res)).toEqual({
			uploadUrl: 'https://s3.example/presigned-put',
			imageUrl: expect.stringMatching(/^\/data\/festival-images\/tmr26-[0-9a-f]{16}\.jpg$/)
		});

		const [, putCommand, options] = getSignedUrl.mock.calls[0] as [
			unknown,
			{ input: { Bucket: string; Key: string; ContentType: string; ContentLength: number } },
			{ expiresIn: number }
		];
		expect(putCommand.input).toMatchObject({
			Bucket: 'stagehopper-radomskyi-com',
			ContentType: 'image/jpeg',
			ContentLength: 500_000
		});
		expect(putCommand.input.Key).toMatch(/^data\/festival-images\/tmr26-[0-9a-f]{16}\.jpg$/);
		expect(options.expiresIn).toBe(300);
	});

	it('maps each allowed content type to its extension', async () => {
		const pngRes = await presign({ contentType: 'image/png', contentLength: 1000 });
		expect(bodyOf(pngRes).imageUrl).toMatch(/\.png$/);

		const webpRes = await presign({ contentType: 'image/webp', contentLength: 1000 });
		expect(bodyOf(webpRes).imageUrl).toMatch(/\.webp$/);
	});

	it('gives two uploads for the same festival different keys', async () => {
		const first = await presign({ contentType: 'image/jpeg', contentLength: 1000 });
		const second = await presign({ contentType: 'image/jpeg', contentLength: 1000 });

		expect(bodyOf(first).imageUrl).not.toBe(bodyOf(second).imageUrl);
	});

	it('rejects a disallowed content type before checking identity', async () => {
		const res = await presign({ contentType: 'image/gif', contentLength: 1000 });

		expect(statusOf(res)).toBe(400);
		expect(getSignedUrl).not.toHaveBeenCalled();
	});

	it('rejects a non-image content type', async () => {
		const res = await presign({
			contentType: 'application/octet-stream',
			contentLength: 1000
		});

		expect(statusOf(res)).toBe(400);
	});

	it.each([
		['zero', 0],
		['negative', -1],
		['too large', 5_000_001],
		['non-integer', 1000.5]
	])('rejects a contentLength that is %s', async (_label, contentLength) => {
		const res = await presign({ contentType: 'image/jpeg', contentLength });

		expect(statusOf(res)).toBe(400);
		expect(getSignedUrl).not.toHaveBeenCalled();
	});

	it('rejects a non-numeric contentLength', async () => {
		const res = await presign({ contentType: 'image/jpeg', contentLength: '500000' });

		expect(statusOf(res)).toBe(400);
	});

	it('rejects a malformed festival id', async () => {
		const res = await presign(
			{ contentType: 'image/jpeg', contentLength: 1000 },
			'Not An Id'
		);

		expect(statusOf(res)).toBe(400);
	});

	it('answers 500 when presigning fails', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		getSignedUrl.mockRejectedValue(new Error('signing error'));

		const res = await presign({ contentType: 'image/jpeg', contentLength: 1000 });

		expect(statusOf(res)).toBe(500);
		consoleError.mockRestore();
	});
});

describe('admin: festival map upload', () => {
	beforeEach(() => {
		vi.resetModules();
		s3Send.mockReset();
		getSignedUrl.mockReset().mockResolvedValue('https://s3.example/presigned-put');
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
		process.env.SITE_BUCKET = 'stagehopper-radomskyi-com';
	});

	afterEach(() => {
		delete process.env.SITE_ORIGIN;
		delete process.env.SITE_BUCKET;
	});

	async function presignMap(
		body: unknown,
		festivalId = 'tmr26',
		overrides: Partial<APIGatewayProxyEventV2> = {}
	) {
		const { handler } = await loadLambda();
		return handler(
			event({
				routeKey: 'POST /api/stagehopper/admin/festivals/{id}/map-upload',
				pathParameters: { id: festivalId },
				body: JSON.stringify(body),
				...overrides
			})
		);
	}

	it('mints a presigned URL for an allowed content type and size', async () => {
		const res = await presignMap({ contentType: 'image/png', contentLength: 2_000_000 });

		expect(statusOf(res)).toBe(200);
		expect(bodyOf(res)).toEqual({
			uploadUrl: 'https://s3.example/presigned-put',
			imageUrl: expect.stringMatching(/^\/data\/festival-maps\/tmr26-[0-9a-f]{16}\.png$/)
		});
	});

	it('uses the festival-maps key prefix', async () => {
		const res = await presignMap({ contentType: 'image/jpeg', contentLength: 1000 });

		expect(statusOf(res)).toBe(200);
		const [, putCommand] = getSignedUrl.mock.calls[0] as [unknown, { input: { Key: string } }];
		expect(putCommand.input.Key).toMatch(/^data\/festival-maps\//);
	});

	it('rejects a disallowed content type', async () => {
		const res = await presignMap({ contentType: 'image/gif', contentLength: 1000 });

		expect(statusOf(res)).toBe(400);
		expect(getSignedUrl).not.toHaveBeenCalled();
	});

});

describe('admin: timetable import', () => {
	/** The upload shape — no ids; the importer assigns its own regardless. */
	function uploadTimetable(overrides: Record<string, unknown> = {}) {
		return {
			formatVersion: 1,
			festivalId: 'tmr26',
			days: [
				{
					date: '2026-07-17',
					performances: [{ artist: 'A', stage: 'MAIN', startTime: '22:00', endTime: '23:00' }]
				}
			],
			...overrides
		};
	}

	beforeEach(() => {
		vi.resetModules();
		send.mockReset().mockResolvedValue({ Items: [] });
		s3Send.mockReset().mockResolvedValue({});
		cloudfrontSend.mockReset().mockResolvedValue({});
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
		process.env.SITE_BUCKET = 'stagehopper-radomskyi-com';
		process.env.CF_DISTRIBUTION_ID = 'EDFDVBD6EXAMPLE';
		process.env.FESTIVALS_TABLE = 'stagehopper-festivals';
		process.env.PERFORMANCES_TABLE = 'stagehopper-performances';
		process.env.ROOMS_TABLE = 'stagehopper-rooms';
	});

	afterEach(() => {
		delete process.env.SITE_ORIGIN;
		delete process.env.SITE_BUCKET;
		delete process.env.CF_DISTRIBUTION_ID;
		delete process.env.FESTIVALS_TABLE;
		delete process.env.PERFORMANCES_TABLE;
		delete process.env.ROOMS_TABLE;
	});

	async function importTimetable(body: unknown, festivalId = 'tmr26') {
		const { handler } = await loadLambda();
		return handler(
			event({
				routeKey: 'POST /api/stagehopper/admin/festivals/{id}/timetable-import',
				pathParameters: { id: festivalId },
				body: JSON.stringify(body)
			})
		);
	}

	/**
	 * Simulates `PERFORMANCES_TABLE`: the existence-check `Query` (and the post-write
	 * republish `Query`) both read from the same in-memory store that `BatchWrite`
	 * populates, so a happy-path import both refuses to double-import and republishes
	 * exactly what it wrote — same as the real table.
	 */
	function wirePerformancesStore() {
		const stored: Record<string, unknown>[] = [];
		send.mockImplementation((command: MockCommand) => {
			if (command.__command === 'Query') return Promise.resolve({ Items: stored });
			if (command.__command === 'BatchWrite') {
				const requests = (command.input.RequestItems?.['stagehopper-performances'] ?? []) as {
					PutRequest: { Item: Record<string, unknown> };
				}[];
				stored.push(...requests.map((r) => r.PutRequest.Item));
				return Promise.resolve({ UnprocessedItems: {} });
			}
			return Promise.resolve({});
		});
		return stored;
	}

	describe('validateTimetableUploadPayload (upload shape — no id required)', () => {
		it('accepts a well-formed upload with no ids at all', async () => {
			const { validateTimetableUploadPayload } = await loadLambda();

			const result = validateTimetableUploadPayload(uploadTimetable());

			expect(result.error).toBeUndefined();
			expect(result.data).toEqual(uploadTimetable());
		});

		it('accepts a file whose performances happen to carry ids — they are simply not inspected', async () => {
			const { validateTimetableUploadPayload } = await loadLambda();
			const withIds = uploadTimetable({
				days: [
					{
						date: '2026-07-17',
						performances: [
							{ id: 'whatever', artist: 'A', stage: 'MAIN', startTime: '22:00', endTime: '23:00' }
						]
					}
				]
			});

			expect(validateTimetableUploadPayload(withIds).error).toBeUndefined();
		});

		it('does not reject duplicate ids across performances — ids are not part of this shape', async () => {
			const { validateTimetableUploadPayload } = await loadLambda();
			const dupIds = uploadTimetable({
				days: [
					{
						date: '2026-07-17',
						performances: [
							{ id: 'dup', artist: 'A', stage: 'MAIN', startTime: '22:00', endTime: '23:00' },
							{ id: 'dup', artist: 'B', stage: 'MAIN', startTime: '20:00', endTime: '21:00' }
						]
					}
				]
			});

			expect(validateTimetableUploadPayload(dupIds).error).toBeUndefined();
		});

		it.each([
			['a non-object payload', 'not an object', /must be an object/i],
			['the wrong formatVersion', uploadTimetable({ formatVersion: 2 }), /formatVersion must be 1/i],
			['a missing festivalId', uploadTimetable({ festivalId: '' }), /festivalId is required/i],
			['an empty days array', uploadTimetable({ days: [] }), /non-empty array/i],
			[
				'a malformed day date',
				uploadTimetable({ days: [{ date: '17-07-2026', performances: [] }] }),
				/ISO date/i
			],
			[
				'a missing artist',
				uploadTimetable({
					days: [
						{
							date: '2026-07-17',
							performances: [{ stage: 'MAIN', startTime: '22:00', endTime: '23:00' }]
						}
					]
				}),
				/needs an artist/i
			],
			[
				'a missing stage',
				uploadTimetable({
					days: [
						{
							date: '2026-07-17',
							performances: [{ artist: 'A', startTime: '22:00', endTime: '23:00' }]
						}
					]
				}),
				/needs a stage/i
			],
			[
				'a bad HH:MM startTime',
				uploadTimetable({
					days: [
						{
							date: '2026-07-17',
							performances: [{ artist: 'A', stage: 'MAIN', startTime: '10pm', endTime: '23:00' }]
						}
					]
				}),
				/startTime must be HH:MM/i
			]
		])('rejects %s', async (_label, payload, expected) => {
			const { validateTimetableUploadPayload } = await loadLambda();

			expect(validateTimetableUploadPayload(payload).error).toMatch(expected);
		});
	});

	describe('POST /admin/festivals/{id}/timetable-import', () => {
		it('writes the timetable, assigning every performance a generated hex id', async () => {
			wirePerformancesStore();

			const res = await importTimetable({ timetable: uploadTimetable() });

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({ ok: true, published: true, replaced: 0 });

			const putCommand = s3Send.mock.calls
				.map(([command]) => command as MockCommand)
				.find((command) => command.__command === 'PutObject');
			expect(putCommand?.input).toMatchObject({
				Bucket: 'stagehopper-radomskyi-com',
				Key: 'data/festivals/tmr26/timetable.json',
				ContentType: 'application/json'
			});

			const written = JSON.parse(String(putCommand?.input.Body));
			expect(written).toMatchObject({ formatVersion: 1, festivalId: 'tmr26' });
			expect(written.days[0].performances[0]).toMatchObject({
				artist: 'A',
				stage: 'MAIN',
				startTime: '22:00',
				endTime: '23:00'
			});
			expect(written.days[0].performances[0].id).toMatch(/^[0-9a-f]{6}$/);

			const [invalidateCommand] = cloudfrontSend.mock.calls[0] as [
				{ input: { InvalidationBatch: { Paths: { Items: string[] } } } }
			];
			expect(invalidateCommand.input.InvalidationBatch.Paths.Items).toEqual([
				'/data/festivals/tmr26/timetable.json'
			]);
		});

		// This is the case a review comment on this feature specifically flagged: an
		// uploaded file must not be able to dictate its own performance ids, even by
		// accident (an old export, a hand-edited file with stale ids from elsewhere).
		it('ignores any id the uploaded file supplies and assigns its own', async () => {
			wirePerformancesStore();
			const withCallerId = uploadTimetable({
				days: [
					{
						date: '2026-07-17',
						performances: [
							{
								id: 'caller-supplied-id',
								artist: 'A',
								stage: 'MAIN',
								startTime: '22:00',
								endTime: '23:00'
							}
						]
					}
				]
			});

			await importTimetable({ timetable: withCallerId });

			const putCommand = s3Send.mock.calls
				.map(([command]) => command as MockCommand)
				.find((command) => command.__command === 'PutObject');
			const written = JSON.parse(String(putCommand?.input.Body));
			expect(written.days[0].performances[0].id).not.toBe('caller-supplied-id');
			expect(written.days[0].performances[0].id).toMatch(/^[0-9a-f]{6}$/);
		});

		// The upload is parsed JSON, so its declared type bounds nothing at runtime. Without
		// an explicit field list every attribute in the file rode into DynamoDB and straight
		// out into the public timetable everyone downloads.
		it('keeps only known performance fields, dropping anything else the file carries', async () => {
			wirePerformancesStore();
			const withExtras = uploadTimetable({
				days: [
					{
						date: '2026-07-17',
						performances: [
							{
								artist: 'A',
								stage: 'MAIN',
								startTime: '22:00',
								endTime: '23:00',
								spotify: 'https://open.spotify.com/artist/1',
								internalNote: 'do not publish',
								ticketPrice: 42
							}
						]
					}
				]
			});

			await importTimetable({ timetable: withExtras });

			const putCommand = s3Send.mock.calls
				.map(([command]) => command as MockCommand)
				.find((command) => command.__command === 'PutObject');
			const written = JSON.parse(String(putCommand?.input.Body));
			const performance = written.days[0].performances[0];
			expect(performance.spotify).toBe('https://open.spotify.com/artist/1');
			expect(performance).not.toHaveProperty('internalNote');
			expect(performance).not.toHaveProperty('ticketPrice');
		});

		it('assigns a distinct id to every performance, across days', async () => {
			wirePerformancesStore();
			const manyPerformances = uploadTimetable({
				days: [
					{
						date: '2026-07-17',
						performances: Array.from({ length: 20 }, (_, i) => ({
							artist: `Artist ${i}`,
							stage: 'MAIN',
							startTime: '22:00',
							endTime: '23:00'
						}))
					},
					{
						date: '2026-07-18',
						performances: Array.from({ length: 20 }, (_, i) => ({
							artist: `Artist ${i + 20}`,
							stage: 'MAIN',
							startTime: '22:00',
							endTime: '23:00'
						}))
					}
				]
			});

			await importTimetable({ timetable: manyPerformances });

			const putCommand = s3Send.mock.calls
				.map(([command]) => command as MockCommand)
				.find((command) => command.__command === 'PutObject');
			const written = JSON.parse(String(putCommand?.input.Body));
			const ids = written.days.flatMap((day: { performances: { id: string }[] }) =>
				day.performances.map((p) => p.id)
			);
			expect(ids).toHaveLength(40);
			expect(new Set(ids).size).toBe(40);
		});

		// Still the default: a double-submitted form cannot wipe a timetable by itself.
		it('refuses to overwrite a timetable that already exists', async () => {
			send.mockImplementation((command: MockCommand) =>
				command.__command === 'Query'
					? Promise.resolve({ Items: [{ festivalId: 'tmr26', id: 'existing' }] })
					: Promise.resolve({})
			);

			const res = await importTimetable({ timetable: uploadTimetable() });

			expect(statusOf(res)).toBe(409);
			expect(commandsOfType('BatchWrite')).toHaveLength(0);
		});

		describe('re-import (replace: true)', () => {
			/** `Query` answers the existence check and the id sweep; `Scan` answers the rooms gate. */
			function wireExisting({
				performances = [] as Record<string, unknown>[],
				rooms = [] as Record<string, unknown>[],
				festival = undefined as Record<string, unknown> | undefined
			} = {}) {
				const written: Record<string, unknown>[] = [];
				send.mockImplementation((command: MockCommand) => {
					if (command.__command === 'Query') {
						// After the replace, the republish sweep must see only what was just written.
						return Promise.resolve({ Items: written.length > 0 ? written : performances });
					}
					if (command.__command === 'Scan') return Promise.resolve({ Items: rooms });
					if (command.__command === 'Get') return Promise.resolve({ Item: festival });
					if (command.__command === 'BatchWrite') {
						const requests = (command.input.RequestItems?.[
							'stagehopper-performances'
						] ?? []) as { PutRequest?: { Item: Record<string, unknown> } }[];
						written.push(
							...requests.filter((r) => r.PutRequest).map((r) => r.PutRequest!.Item)
						);
						return Promise.resolve({ UnprocessedItems: {} });
					}
					return Promise.resolve({});
				});
				return written;
			}

			const EXISTING = [
				{
					festivalId: 'tmr26',
					id: 'old1',
					date: '2026-07-17',
					artist: 'Old',
					stage: 'GONE',
					startTime: '20:00',
					endTime: '21:00'
				}
			];

			// The whole point of the gate: a re-import re-keys every performance, and every pick
			// and notification override is keyed by a performance id. There is no override — the
			// way through is deleting the rooms, which is a separate, explicit decision.
			it('refuses to replace a timetable while the festival has rooms', async () => {
				wireExisting({
					performances: EXISTING,
					rooms: [{ roomId: 'tmr26-abc123' }]
				});

				const res = await importTimetable({
					timetable: uploadTimetable(),
					replace: true
				});

				expect(statusOf(res)).toBe(409);
				expect(bodyOf(res)).toEqual({
					error:
						'Festival schedule cannot be re-imported, since there are existing festival rooms.'
				});
				// Nothing written, nothing published.
				expect(commandsOfType('BatchWrite')).toHaveLength(0);
				expect(s3Send).not.toHaveBeenCalled();
			});

			// A room belonging to some other festival must not block this one.
			it('ignores rooms that belong to a different festival', async () => {
				// The gate filters server-side; an empty page is what a non-matching table returns.
				wireExisting({ performances: EXISTING, rooms: [] });

				const res = await importTimetable({
					timetable: uploadTimetable(),
					replace: true
				});

				expect(statusOf(res)).toBe(200);
				const scan = commandsOfType('Scan')[0]!;
				expect(scan.input.TableName).toBe('stagehopper-rooms');
				expect(scan.input.ExpressionAttributeValues![':fid']).toBe('tmr26');
			});

			it('deletes every old performance and writes the new ones with fresh ids', async () => {
				wireExisting({ performances: EXISTING });

				const res = await importTimetable({
					timetable: uploadTimetable(),
					replace: true
				});

				expect(statusOf(res)).toBe(200);
				expect(bodyOf(res)).toMatchObject({ ok: true, published: true, replaced: 1 });

				const batches = commandsOfType('BatchWrite');
				const requests = batches.flatMap(
					(cmd) =>
						(cmd.input.RequestItems?.['stagehopper-performances'] ?? []) as {
							DeleteRequest?: { Key: Record<string, unknown> };
							PutRequest?: { Item: Record<string, unknown> };
						}[]
				);
				expect(requests.filter((r) => r.DeleteRequest).map((r) => r.DeleteRequest!.Key)).toEqual([
					{ festivalId: 'tmr26', id: 'old1' }
				]);

				const puts = requests.filter((r) => r.PutRequest).map((r) => r.PutRequest!.Item);
				expect(puts).toHaveLength(1);
				expect(puts[0]).toMatchObject({ artist: 'A', stage: 'MAIN' });
				expect(puts[0]!.id).not.toBe('old1');
				expect(String(puts[0]!.id)).toMatch(/^[0-9a-f]{6}$/);
			});

			// Order is the guarantee on offer: nothing public moves until DynamoDB has settled.
			it('deletes before it inserts, and publishes only after both', async () => {
				wireExisting({ performances: EXISTING });

				await importTimetable({ timetable: uploadTimetable(), replace: true });

				const kinds = commandsOfType('BatchWrite').flatMap((cmd) =>
					(
						(cmd.input.RequestItems?.['stagehopper-performances'] ?? []) as {
							DeleteRequest?: unknown;
						}[]
					).map((r) => (r.DeleteRequest ? 'delete' : 'put'))
				);
				expect(kinds).toEqual(['delete', 'put']);
				expect(s3Send).toHaveBeenCalled();
			});

			it('answers 500 and publishes nothing when the rewrite fails part-way', async () => {
				const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
				send.mockImplementation((command: MockCommand) => {
					if (command.__command === 'Query') return Promise.resolve({ Items: EXISTING });
					if (command.__command === 'Scan') return Promise.resolve({ Items: [] });
					if (command.__command === 'BatchWrite') {
						return Promise.reject(new Error('provisioned throughput exceeded'));
					}
					return Promise.resolve({});
				});

				const res = await importTimetable({
					timetable: uploadTimetable(),
					replace: true
				});

				expect(statusOf(res)).toBe(500);
				// Visitors stay on the old timetable; re-running the import is the whole recovery.
				expect(s3Send).not.toHaveBeenCalled();
				consoleError.mockRestore();
			});

			// Colours and order are keyed by stage *name*, which the import does not re-key, so
			// deliberate styling survives a re-import. Only stages the new file dropped go.
			it('keeps stage colours for surviving stages and prunes the vanished ones', async () => {
				wireExisting({
					performances: EXISTING,
					festival: {
						id: 'tmr26',
						stageColors: { MAIN: '#ff0000', GONE: '#00ff00' },
						stageOrder: ['GONE', 'MAIN']
					}
				});

				await importTimetable({ timetable: uploadTimetable(), replace: true });

				const prune = commandsOfType('Update').find(
					(cmd) => cmd.input.TableName === 'stagehopper-festivals'
				)!;
				expect(prune.input.ExpressionAttributeValues![':colors']).toEqual({ MAIN: '#ff0000' });
				expect(prune.input.ExpressionAttributeValues![':order']).toEqual(['MAIN']);
			});

			it('leaves the festival record alone when every stage survives', async () => {
				wireExisting({
					performances: EXISTING,
					festival: { id: 'tmr26', stageColors: { MAIN: '#ff0000' }, stageOrder: ['MAIN'] }
				});

				await importTimetable({ timetable: uploadTimetable(), replace: true });

				expect(
					commandsOfType('Update').filter((cmd) => cmd.input.TableName === 'stagehopper-festivals')
				).toHaveLength(0);
			});

			// A first import is not destructive, so it never consults the gate.
			it('does not check for rooms when there is no timetable to replace', async () => {
				wirePerformancesStore();

				const res = await importTimetable({ timetable: uploadTimetable(), replace: true });

				expect(statusOf(res)).toBe(200);
				expect(commandsOfType('Scan')).toHaveLength(0);
			});

			it('rejects a non-boolean replace flag', async () => {
				const res = await importTimetable({
					timetable: uploadTimetable(),
					replace: 'yes'
				});

				expect(statusOf(res)).toBe(400);
				expect(send).not.toHaveBeenCalled();
			});

			// Never fail an import over bookkeeping that runs after the timetable is already in.
			it('still reports success when pruning stage settings fails', async () => {
				const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
				const written: Record<string, unknown>[] = [];
				send.mockImplementation((command: MockCommand) => {
					if (command.__command === 'Query') {
						return Promise.resolve({ Items: written.length > 0 ? written : EXISTING });
					}
					if (command.__command === 'Scan') return Promise.resolve({ Items: [] });
					if (command.__command === 'Get') return Promise.reject(new Error('access denied'));
					if (command.__command === 'BatchWrite') {
						const requests = (command.input.RequestItems?.[
							'stagehopper-performances'
						] ?? []) as { PutRequest?: { Item: Record<string, unknown> } }[];
						written.push(
							...requests.filter((r) => r.PutRequest).map((r) => r.PutRequest!.Item)
						);
						return Promise.resolve({ UnprocessedItems: {} });
					}
					return Promise.resolve({});
				});

				const res = await importTimetable({
					timetable: uploadTimetable(),
					replace: true
				});

				expect(statusOf(res)).toBe(200);
				expect(s3Send).toHaveBeenCalled();
				consoleError.mockRestore();
			});
		});

		it('rejects a timetable whose festivalId does not match the target festival', async () => {
			const res = await importTimetable(
				{ timetable: uploadTimetable({ festivalId: 'ps26' }) },
				'tmr26'
			);

			expect(statusOf(res)).toBe(400);
			expect(send).not.toHaveBeenCalled();
		});

		it('rejects a malformed festival id in the path', async () => {
			const res = await importTimetable(
				{ timetable: uploadTimetable() },
				'Not An Id'
			);

			expect(statusOf(res)).toBe(400);
		});

		it('rejects a request with no path parameters at all', async () => {
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'POST /api/stagehopper/admin/festivals/{id}/timetable-import',
					body: JSON.stringify({ timetable: uploadTimetable() })
				})
			);

			expect(statusOf(res)).toBe(400);
			expect(send).not.toHaveBeenCalled();
		});

		it('rejects an invalid timetable before checking identity', async () => {
			const res = await importTimetable({ timetable: uploadTimetable({ days: [] }) });

			expect(statusOf(res)).toBe(400);
			expect(send).not.toHaveBeenCalled();
		});

		it('answers 500 when checking for an existing timetable fails unexpectedly', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			send.mockRejectedValue(new Error('access denied'));

			const res = await importTimetable({ timetable: uploadTimetable() });

			expect(statusOf(res)).toBe(500);
			consoleError.mockRestore();
		});

		it('answers 500 when writing the performances fails', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			send.mockImplementation((command: MockCommand) => {
				if (command.__command === 'Query') return Promise.resolve({ Items: [] });
				if (command.__command === 'BatchWrite') return Promise.reject(new Error('access denied'));
				return Promise.resolve({});
			});

			const res = await importTimetable({ timetable: uploadTimetable() });

			expect(statusOf(res)).toBe(500);
			consoleError.mockRestore();
		});

		it('still reports success and published:true when only the CloudFront invalidation fails', async () => {
			// The S3 write is what actually publishes the content; the no-cache header means
			// a missed invalidation just costs one extra origin round-trip, not stale data.
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			wirePerformancesStore();
			cloudfrontSend.mockRejectedValue(new Error('rate limited'));

			const res = await importTimetable({ timetable: uploadTimetable() });

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({ ok: true, published: true, replaced: 0 });
			consoleError.mockRestore();
		});

		it('reports published:false when the S3 write itself fails', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			wirePerformancesStore();
			s3Send.mockRejectedValue(new Error('access denied'));

			const res = await importTimetable({ timetable: uploadTimetable() });

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({ ok: true, published: false, replaced: 0 });
			consoleError.mockRestore();
		});
	});
});

describe('admin: per-performance timetable editing', () => {
	/** Flattened `PERFORMANCES_TABLE` rows equivalent to the old STORED_TIMETABLE fixture. */
	const STORED_PERFORMANCES = [
		{ festivalId: 'tmr26', id: 'p1', date: '2026-07-17', artist: 'A', stage: 'Main', startTime: '22:00', endTime: '23:00' },
		{ festivalId: 'tmr26', id: 'p2', date: '2026-07-17', artist: 'B', stage: 'Second', startTime: '20:00', endTime: '21:00' },
		{ festivalId: 'tmr26', id: 'p3', date: '2026-07-18', artist: 'C', stage: 'Main', startTime: '19:00', endTime: '20:00' }
	];

	beforeEach(() => {
		vi.resetModules();
		send.mockReset();
		s3Send.mockReset().mockResolvedValue({});
		cloudfrontSend.mockReset().mockResolvedValue({});
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
		process.env.SITE_BUCKET = 'stagehopper-radomskyi-com';
		process.env.CF_DISTRIBUTION_ID = 'EDFDVBD6EXAMPLE';
		process.env.FESTIVALS_TABLE = 'stagehopper-festivals';
		process.env.PERFORMANCES_TABLE = 'stagehopper-performances';
	});

	afterEach(() => {
		delete process.env.SITE_ORIGIN;
		delete process.env.SITE_BUCKET;
		delete process.env.CF_DISTRIBUTION_ID;
		delete process.env.FESTIVALS_TABLE;
		delete process.env.PERFORMANCES_TABLE;
	});

	async function patchTimetable(
		body: unknown,
		festivalId = 'tmr26',
		overrides: Partial<APIGatewayProxyEventV2> = {}
	) {
		const { handler } = await loadLambda();
		return handler(
			event({
				routeKey: 'PATCH /api/stagehopper/admin/festivals/{id}/timetable',
				pathParameters: { id: festivalId },
				body: JSON.stringify(body),
				...overrides
			})
		);
	}

	/**
	 * Simulates `PERFORMANCES_TABLE` as an in-memory `(festivalId, id)` store: `Get`,
	 * `Put`, `Update` and `Delete` all read/write it, `Query` lists everything for a
	 * festival — the same shape `patchFestivalTimetable`'s Get-then-write-then-republish
	 * flow actually exercises.
	 */
	function wireTimetableStore(initial: Record<string, unknown>[] = STORED_PERFORMANCES) {
		const items = new Map<string, Record<string, unknown>>();
		for (const item of initial) items.set(item.id as string, { ...item });

		send.mockImplementation((command: MockCommand) => {
			switch (command.__command) {
				case 'Get':
					return Promise.resolve({ Item: items.get(command.input.Key.id) });
				case 'Put':
					items.set(command.input.Item.id, command.input.Item);
					return Promise.resolve({});
				case 'Delete':
					items.delete(command.input.Key.id);
					return Promise.resolve({});
				case 'Update': {
					const current = { ...(items.get(command.input.Key.id) ?? {}) };
					const names = (command.input.ExpressionAttributeNames ?? {}) as Record<string, string>;
					const values = (command.input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
					for (const [nameKey, attrName] of Object.entries(names)) {
						current[attrName] = values[nameKey.replace('#', ':')];
					}
					items.set(command.input.Key.id, current);
					return Promise.resolve({});
				}
				case 'Query':
					return Promise.resolve({ Items: [...items.values()] });
				default:
					return Promise.resolve({});
			}
		});
		return items;
	}

	/** The republished timetable from the response body — no S3 parsing needed. */
	function timetableOf(res: unknown): any {
		return bodyOf(res).timetable;
	}

	function dayOf(timetable: any, date: string): any {
		return timetable.days.find((d: { date: string }) => d.date === date);
	}

	function performanceOf(timetable: any, id: string): any {
		for (const day of timetable.days) {
			const found = day.performances.find((p: { id: string }) => p.id === id);
			if (found) return found;
		}
		return undefined;
	}

	describe('updating an existing performance', () => {
		it('applies the patch to the right performance and leaves everything else byte-identical', async () => {
			wireTimetableStore();

			const res = await patchTimetable({
				performanceId: 'p1',
				patch: { artist: 'Updated Artist' }
			});

			expect(statusOf(res)).toBe(200);
			const written = timetableOf(res);
			expect(performanceOf(written, 'p1')).toEqual({
				id: 'p1',
				artist: 'Updated Artist',
				stage: 'Main',
				startTime: '22:00',
				endTime: '23:00'
			});
			// Untouched performances are unchanged.
			expect(performanceOf(written, 'p2')).toEqual({
				id: 'p2',
				artist: 'B',
				stage: 'Second',
				startTime: '20:00',
				endTime: '21:00'
			});
			expect(performanceOf(written, 'p3')).toEqual({
				id: 'p3',
				artist: 'C',
				stage: 'Main',
				startTime: '19:00',
				endTime: '20:00'
			});
		});

		it('invalidates the timetable path on success', async () => {
			wireTimetableStore();

			await patchTimetable({ performanceId: 'p1', patch: { artist: 'X' } });

			const [invalidateCommand] = cloudfrontSend.mock.calls[0] as [
				{ input: { InvalidationBatch: { Paths: { Items: string[] } } } }
			];
			expect(invalidateCommand.input.InvalidationBatch.Paths.Items).toEqual([
				'/data/festivals/tmr26/timetable.json'
			]);
		});

		it('rejects a bad HH:MM time before writing anything', async () => {
			const items = wireTimetableStore();

			const res = await patchTimetable({
				performanceId: 'p1',
				patch: { startTime: '10pm' }
			});

			expect(statusOf(res)).toBe(400);
			expect(items.get('p1')).toEqual(STORED_PERFORMANCES[0]);
		});

		it('rejects an unknown field before writing anything', async () => {
			const items = wireTimetableStore();

			const res = await patchTimetable({
				performanceId: 'p1',
				patch: { favoriteColor: 'blue' }
			});

			expect(statusOf(res)).toBe(400);
			expect(bodyOf(res).error).toMatch(/unknown field/i);
			expect(items.get('p1')).toEqual(STORED_PERFORMANCES[0]);
		});

		it('rejects an empty patch object', async () => {
			const items = wireTimetableStore();

			const res = await patchTimetable({ performanceId: 'p1', patch: {} });

			expect(statusOf(res)).toBe(400);
			expect(items.get('p1')).toEqual(STORED_PERFORMANCES[0]);
		});

		it('rejects a performanceId that does not exist and is not a well-formed add', async () => {
			const items = wireTimetableStore();

			const res = await patchTimetable({
				performanceId: 'no-such-id',
				patch: { artist: 'Only artist, missing everything else required to add' }
			});

			expect(statusOf(res)).toBe(400);
			expect(items.has('no-such-id')).toBe(false);
		});
	});

	describe('deleting a performance', () => {
		it('removes it and leaves everything else untouched', async () => {
			wireTimetableStore();

			const res = await patchTimetable({ performanceId: 'p1', patch: null });

			expect(statusOf(res)).toBe(200);
			const written = timetableOf(res);
			expect(performanceOf(written, 'p1')).toBeUndefined();
			expect(performanceOf(written, 'p2')).toBeDefined();
			expect(performanceOf(written, 'p3')).toBeDefined();
		});

		it('rejects deleting an id that does not exist', async () => {
			wireTimetableStore();

			const res = await patchTimetable({ performanceId: 'no-such-id', patch: null });

			expect(statusOf(res)).toBe(400);
			expect(commandsOfType('Delete')).toHaveLength(0);
		});
	});

	describe('adding a performance', () => {
		const NEW_PERFORMANCE_PATCH = {
			date: '2026-07-17',
			artist: 'New Artist',
			stage: 'Third',
			startTime: '18:00',
			endTime: '19:00'
		};

		it('adds it to the matching day and leaves the rest untouched', async () => {
			wireTimetableStore();

			const res = await patchTimetable({
				performanceId: 'brand-new-id',
				patch: NEW_PERFORMANCE_PATCH
			});

			expect(statusOf(res)).toBe(200);
			const written = timetableOf(res);
			expect(dayOf(written, '2026-07-17').performances).toHaveLength(3);
			expect(performanceOf(written, 'brand-new-id')).toEqual({
				id: 'brand-new-id',
				artist: 'New Artist',
				stage: 'Third',
				startTime: '18:00',
				endTime: '19:00'
			});
			expect(performanceOf(written, 'p1')).toBeDefined();
		});

		it('creates a new day when the date does not exist yet', async () => {
			wireTimetableStore();

			const res = await patchTimetable({
				performanceId: 'brand-new-id',
				patch: { ...NEW_PERFORMANCE_PATCH, date: '2026-07-19' }
			});

			expect(statusOf(res)).toBe(200);
			const written = timetableOf(res);
			expect(written.days).toHaveLength(3);
			expect(dayOf(written, '2026-07-19')).toBeDefined();
		});

		it('rejects an add missing a required field', async () => {
			const items = wireTimetableStore();
			const { stage: _stage, ...missingStage } = NEW_PERFORMANCE_PATCH;

			const res = await patchTimetable({
				performanceId: 'brand-new-id',
				patch: missingStage
			});

			expect(statusOf(res)).toBe(400);
			expect(items.has('brand-new-id')).toBe(false);
		});

		it('rejects an add with a malformed date', async () => {
			const items = wireTimetableStore();

			const res = await patchTimetable({
				performanceId: 'brand-new-id',
				patch: { ...NEW_PERFORMANCE_PATCH, date: '17-07-2026' }
			});

			expect(statusOf(res)).toBe(400);
			expect(items.has('brand-new-id')).toBe(false);
		});

		it('treats a patch id that already exists as an update, not an add — date is rejected', async () => {
			// The op is inferred purely from whether performanceId already exists, so an
			// "add"-shaped patch (including `date`, which only means something when
			// placing a new performance) sent against an existing id takes the update
			// path instead — where `date` isn't an editable field.
			const items = wireTimetableStore();

			const res = await patchTimetable({
				performanceId: 'p2',
				patch: NEW_PERFORMANCE_PATCH
			});

			expect(statusOf(res)).toBe(400);
			expect(bodyOf(res).error).toMatch(/unknown field: date/i);
			expect(items.get('p2')).toEqual(STORED_PERFORMANCES[1]);
		});

		it('updates an existing performance in place when the patch omits date', async () => {
			wireTimetableStore();
			const { date: _date, ...updateOnly } = NEW_PERFORMANCE_PATCH;

			const res = await patchTimetable({
				performanceId: 'p2',
				patch: updateOnly
			});

			expect(statusOf(res)).toBe(200);
			const written = timetableOf(res);
			expect(performanceOf(written, 'p2')).toMatchObject({ id: 'p2', artist: 'New Artist' });
		});
	});

	describe('authorization and request shape', () => {
		it('answers 400 when performanceId is missing', async () => {
			const res = await patchTimetable({ patch: { artist: 'X' } });

			expect(statusOf(res)).toBe(400);
		});

		it('answers 400 when patch is entirely absent (not even null)', async () => {
			const res = await patchTimetable({ performanceId: 'p1' });

			expect(statusOf(res)).toBe(400);
		});

		it('answers 400 for a malformed festival id', async () => {
			const res = await patchTimetable(
				{ performanceId: 'p1', patch: { artist: 'X' } },
				'Not An Id'
			);

			expect(statusOf(res)).toBe(400);
		});

		it('answers 500 when reading the existing performance fails', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			send.mockImplementation((command: MockCommand) =>
				command.__command === 'Get' ? Promise.reject(new Error('access denied')) : Promise.resolve({})
			);

			const res = await patchTimetable({ performanceId: 'p1', patch: { artist: 'X' } });

			expect(statusOf(res)).toBe(500);
			consoleError.mockRestore();
		});

		it('answers 500 when the write fails', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			send.mockImplementation((command: MockCommand) => {
				if (command.__command === 'Get') return Promise.resolve({ Item: STORED_PERFORMANCES[0] });
				if (command.__command === 'Update') return Promise.reject(new Error('access denied'));
				return Promise.resolve({});
			});

			const res = await patchTimetable({ performanceId: 'p1', patch: { artist: 'X' } });

			expect(statusOf(res)).toBe(500);
			consoleError.mockRestore();
		});

		it('still reports success and published:true when only the CloudFront invalidation fails', async () => {
			// The S3 write is what actually publishes the content; the no-cache header means
			// a missed invalidation just costs one extra origin round-trip, not stale data.
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			wireTimetableStore();
			cloudfrontSend.mockRejectedValue(new Error('rate limited'));

			const res = await patchTimetable({ performanceId: 'p1', patch: { artist: 'X' } });

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res).published).toBe(true);
			consoleError.mockRestore();
		});

		it('reports published:false when the S3 write itself fails, but still returns the current timetable', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			wireTimetableStore();
			s3Send.mockRejectedValue(new Error('access denied'));

			const res = await patchTimetable({ performanceId: 'p1', patch: { artist: 'X' } });

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res).published).toBe(false);
			expect(performanceOf(timetableOf(res), 'p1')).toMatchObject({ artist: 'X' });
			consoleError.mockRestore();
		});
	});
});

describe('admin: browse and delete rooms and users (#38)', () => {
	beforeEach(() => {
		vi.resetModules();
		send.mockReset();
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
		process.env.TABLE_NAME = 'stagehopper-selections';
		process.env.USERS_TABLE = 'stagehopper-users';
		process.env.ROOMS_TABLE = 'stagehopper-rooms';
		process.env.PUSH_SUBSCRIPTIONS_TABLE = 'stagehopper-push-subscriptions';
	});

	afterEach(() => {
		delete process.env.SITE_ORIGIN;
		delete process.env.TABLE_NAME;
		delete process.env.USERS_TABLE;
		delete process.env.ROOMS_TABLE;
		delete process.env.PUSH_SUBSCRIPTIONS_TABLE;
	});

	function asNonAdmin() {
	}

	/** Route the shared `send` mock by command type. */
	function mockDynamo({
		scanItems = [] as Record<string, unknown>[],
		scanNextKey = undefined as Record<string, unknown> | undefined,
		queryItems = [] as Record<string, unknown>[]
	} = {}) {
		send.mockImplementation((command: MockCommand) => {
			switch (command.__command) {
				case 'Scan':
					return Promise.resolve({ Items: scanItems, LastEvaluatedKey: scanNextKey });
				case 'Query':
					return Promise.resolve({ Items: queryItems });
				default:
					return Promise.resolve({});
			}
		});
	}

	const listRooms = async (body: unknown = {}) => {
		const { handler } = await loadLambda();
		return handler(event({ routeKey: 'POST /api/stagehopper/admin/rooms', body: JSON.stringify(body) }));
	};
	const listUsers = async (body: unknown = {}) => {
		const { handler } = await loadLambda();
		return handler(event({ routeKey: 'POST /api/stagehopper/admin/users', body: JSON.stringify(body) }));
	};
	const deleteRoom = async (roomId: string, body: unknown = {}) => {
		const { handler } = await loadLambda();
		return handler(
			event({
				routeKey: 'DELETE /api/stagehopper/admin/rooms/{roomId}',
				pathParameters: { roomId },
				body: JSON.stringify(body)
			})
		);
	};
	const deleteUser = async (userId: string, body: unknown = {}) => {
		const { handler } = await loadLambda();
		return handler(
			event({
				routeKey: 'DELETE /api/stagehopper/admin/users/{userId}',
				pathParameters: { userId },
				body: JSON.stringify(body)
			})
		);
	};

	describe('listing rooms', () => {
		it('scans one bounded page of users and aggregates rooms from their maps', async () => {
			mockDynamo({
				scanItems: [
					{ userId: 'clerk:1', rooms: { 'tmr26-aaa111': { updatedAt: 100 }, 'ps26-bbb222': { updatedAt: 50 } } },
					{ userId: 'clerk:2', rooms: { 'tmr26-aaa111': { updatedAt: 300 } } }
				]
			});

			const res = await listRooms();

			expect(statusOf(res)).toBe(200);
			const { rooms, nextKey } = bodyOf(res);
			expect(nextKey).toBeNull();
			expect(rooms).toContainEqual({ roomId: 'tmr26-aaa111', participantCount: 2, updatedAt: 300 });
			expect(rooms).toContainEqual({ roomId: 'ps26-bbb222', participantCount: 1, updatedAt: 50 });
			// The scan is capped, and only the users table is touched.
			const scan = commandsOfType('Scan')[0]!;
			expect(scan.input.TableName).toBe('stagehopper-users');
			expect(scan.input.Limit).toBeGreaterThan(0);
		});

		it('surfaces the continuation token and honours an incoming start key', async () => {
			mockDynamo({ scanItems: [], scanNextKey: { userId: 'clerk:5' } });

			const res = await listRooms({ startKey: { userId: 'clerk:1' } });

			expect(bodyOf(res).nextKey).toEqual({ userId: 'clerk:5' });
			expect(commandsOfType('Scan')[0]!.input.ExclusiveStartKey).toEqual({ userId: 'clerk:1' });
		});

	});

	describe('listing users', () => {
		it('lists one entry per user row, roomCount from the rooms map', async () => {
			mockDynamo({
				scanItems: [
					{
						userId: 'clerk:1',
						name: 'New',
						email: 'al@example.com',
						lastActive: 200,
						rooms: { 'tmr26-aaa111': {}, 'ps26-bbb222': {} }
					},
					{ userId: 'clerk:2', name: 'Bo', email: 'bo@example.com', lastActive: 90, rooms: { 'tmr26-aaa111': {} } },
					// A signed-in user who has joined no room: no `rooms` map at all.
					{ userId: 'clerk:3', name: 'Solo', email: 'solo@example.com', lastActive: 300 }
				]
			});

			const { users } = bodyOf(await listUsers());

			expect(users).toContainEqual({
				userId: 'clerk:1',
				name: 'New',
				email: 'al@example.com',
				roomCount: 2,
				lastActive: 200
			});
			expect(users).toContainEqual({
				userId: 'clerk:2',
				name: 'Bo',
				email: 'bo@example.com',
				roomCount: 1,
				lastActive: 90
			});
			// The whole point of this refactor: a user with no rooms still lists, roomCount 0.
			expect(users).toContainEqual({
				userId: 'clerk:3',
				name: 'Solo',
				email: 'solo@example.com',
				roomCount: 0,
				lastActive: 300
			});
		});

	});

	/** Flatten every BatchWrite's DeleteRequests into `{ table, key }` pairs. */
	function allDeletes() {
		return commandsOfType('BatchWrite').flatMap((cmd) =>
			Object.entries(cmd.input.RequestItems as Record<string, { DeleteRequest: { Key: Record<string, unknown> } }[]>).flatMap(
				([table, reqs]) => reqs.map((r) => ({ table, key: r.DeleteRequest.Key }))
			)
		);
	}

	describe('deleting a room', () => {
		it('removes every selection row for the room and drops it from each member', async () => {
			mockDynamo({ queryItems: [{ userId: 'clerk:1' }, { userId: 'clerk:2' }] });

			const res = await deleteRoom('tmr26-aaa111');

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({ ok: true, deleted: 2 });

			// The member list comes from a Query on the selections table by roomId.
			const query = commandsOfType('Query')[0]!;
			expect(query.input.TableName).toBe('stagehopper-selections');

			// Only the selection rows are batch-deleted now.
			const deletes = allDeletes();
			expect(deletes).toContainEqual({ table: 'stagehopper-selections', key: { roomId: 'tmr26-aaa111', userId: 'clerk:1' } });
			expect(deletes).toContainEqual({ table: 'stagehopper-selections', key: { roomId: 'tmr26-aaa111', userId: 'clerk:2' } });
			expect(deletes).toHaveLength(2);

			// Each member's user row has the room removed from its map.
			const removals = commandsOfType('Update').filter((c) => c.input.TableName === 'stagehopper-users');
			expect(removals).toHaveLength(2);
			expect(removals.every((u) => u.input.UpdateExpression === 'REMOVE rooms.#rid')).toBe(true);
			expect(removals.every((u) => u.input.ExpressionAttributeNames['#rid'] === 'tmr26-aaa111')).toBe(true);
			expect(removals.map((u) => (u.input.Key as { userId: string }).userId).sort()).toEqual(['clerk:1', 'clerk:2']);
		});

		// Without this the festival stays blocked from re-import for ever, naming a room the
		// admin has already deleted, with nothing anywhere to explain why.
		it('deletes the index row along with the room', async () => {
			mockDynamo({ queryItems: [{ userId: 'clerk:1' }] });

			await deleteRoom('tmr26-aaa111');

			const deletes = commandsOfType('Delete');
			expect(deletes).toHaveLength(1);
			expect(deletes[0]!.input.TableName).toBe('stagehopper-rooms');
			expect(deletes[0]!.input.Key).toEqual({ roomId: 'tmr26-aaa111' });
		});

		it('chunks the selection deletes past a single 25-item batch', async () => {
			// 30 members → 30 selection deletes → two BatchWrite calls (25 + 5).
			const members = Array.from({ length: 30 }, (_, i) => ({ userId: `clerk:${i}` }));
			mockDynamo({ queryItems: members });

			await deleteRoom('tmr26-aaa111');

			expect(commandsOfType('BatchWrite')).toHaveLength(2);
			expect(allDeletes()).toHaveLength(30);
			// Plus one REMOVE update per member.
			expect(commandsOfType('Update').filter((c) => c.input.TableName === 'stagehopper-users')).toHaveLength(30);
		});

		it('retries items DynamoDB leaves unprocessed', async () => {
			let firstBatch = true;
			send.mockImplementation((command: MockCommand) => {
				if (command.__command === 'Query') return Promise.resolve({ Items: [{ userId: 'clerk:1' }] });
				if (command.__command === 'BatchWrite') {
					if (firstBatch) {
						firstBatch = false;
						// Hand back one item as unprocessed the first time.
						return Promise.resolve({
							UnprocessedItems: { 'stagehopper-selections': [{ DeleteRequest: { Key: { roomId: 'tmr26-aaa111', userId: 'clerk:1' } } }] }
						});
					}
					return Promise.resolve({});
				}
				return Promise.resolve({});
			});

			expect(statusOf(await deleteRoom('tmr26-aaa111'))).toBe(200);
			expect(commandsOfType('BatchWrite').length).toBeGreaterThanOrEqual(2);
		});

		it('answers 400 for a malformed room id, before any read', async () => {
			mockDynamo();

			expect(statusOf(await deleteRoom('Not An Id'))).toBe(400);
			expect(send).not.toHaveBeenCalled();
		});

		it('deletes the room name row too, without counting or cleaning it up as a member', async () => {
			mockDynamo({ queryItems: [{ userId: 'clerk:1' }, { userId: '@room', displayName: 'Squad Goals' }] });

			const res = await deleteRoom('tmr26-aaa111');

			expect(bodyOf(res)).toEqual({ ok: true, deleted: 1 });
			expect(allDeletes()).toContainEqual({
				table: 'stagehopper-selections',
				key: { roomId: 'tmr26-aaa111', userId: '@room' }
			});
			// No USERS_TABLE row exists for '@room' — REMOVE must not be attempted for it.
			const removals = commandsOfType('Update').filter((c) => c.input.TableName === 'stagehopper-users');
			expect(removals).toHaveLength(1);
			expect(removals[0]?.input.Key).toEqual({ userId: 'clerk:1' });
		});
	});

	describe('deleting a user', () => {
		it('removes the user row, their selection rows across every room, and their subscriptions', async () => {
			send.mockImplementation((command: MockCommand) => {
				// The user row names the rooms to clear on the selections table.
				if (command.__command === 'Get') {
					return Promise.resolve({
						Item: { userId: 'clerk:1', rooms: { 'tmr26-aaa111': {}, 'ps26-bbb222': {} } }
					});
				}
				// Their push subscriptions, by userId.
				if (command.__command === 'Query') {
					return Promise.resolve({ Items: [{ endpoint: 'https://push/a' }] });
				}
				return Promise.resolve({});
			});

			const res = await deleteUser('clerk:1');

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({ ok: true, deleted: 2 });

			const deletes = allDeletes();
			expect(deletes).toContainEqual({ table: 'stagehopper-users', key: { userId: 'clerk:1' } });
			expect(deletes).toContainEqual({ table: 'stagehopper-selections', key: { roomId: 'tmr26-aaa111', userId: 'clerk:1' } });
			expect(deletes).toContainEqual({ table: 'stagehopper-selections', key: { roomId: 'ps26-bbb222', userId: 'clerk:1' } });
			expect(deletes).toContainEqual({ table: 'stagehopper-push-subscriptions', key: { userId: 'clerk:1', endpoint: 'https://push/a' } });
			expect(deletes).toHaveLength(4);
		});

		it('answers 400 for a malformed user id, before any read', async () => {
			mockDynamo();

			expect(statusOf(await deleteUser('not-a-user-id'))).toBe(400);
			expect(send).not.toHaveBeenCalled();
		});

	});

	describe('sending a test notification', () => {
		/** Build an InvokeCommand response whose Payload is the notifier's JSON result. */
		function notifierReturns(result: unknown, functionError?: string) {
			lambdaSend.mockReset().mockResolvedValue({
				FunctionError: functionError,
				Payload: new TextEncoder().encode(JSON.stringify(result))
			});
		}

		const testNotify = async (userId: string, body: unknown = {}) => {
			const { handler } = await loadLambda();
			return handler(
				event({
					routeKey: 'POST /api/stagehopper/admin/users/{userId}/test-notification',
					pathParameters: { userId },
					body: JSON.stringify(body)
				})
			);
		};

		it('invokes the notifier with a test event and relays its counts', async () => {
			notifierReturns({ ok: true, sent: 2, total: 2 });

			const res = await testNotify('clerk:1');

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({ ok: true, sent: 2, total: 2 });

			const [invoke] = lambdaSend.mock.calls[0] as [{ input: { FunctionName: string; InvocationType: string; Payload: Uint8Array } }];
			expect(invoke.input.FunctionName).toBe('stagehopper-notifier');
			expect(invoke.input.InvocationType).toBe('RequestResponse');
			expect(JSON.parse(Buffer.from(invoke.input.Payload).toString('utf8'))).toEqual({
				test: true,
				userId: 'clerk:1'
			});
		});

		it('returns 400 with the reason when the user has no reachable devices', async () => {
			notifierReturns({ ok: false, sent: 0, total: 0, error: 'No push subscriptions for this user' });

			const res = await testNotify('clerk:1');

			expect(statusOf(res)).toBe(400);
			expect(bodyOf(res).error).toMatch(/no push subscriptions/i);
		});

		it('returns 500 when the notifier itself errors', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			notifierReturns({ errorMessage: 'boom' }, 'Unhandled');

			expect(statusOf(await testNotify('clerk:1'))).toBe(500);
			consoleError.mockRestore();
		});

		it('rejects a malformed user id before invoking anything', async () => {
			lambdaSend.mockReset();
			expect(statusOf(await testNotify('not-a-user-id'))).toBe(400);
			expect(lambdaSend).not.toHaveBeenCalled();
		});

	});
});
