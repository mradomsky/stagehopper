import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const verifyIdToken = vi.fn();
const send = vi.fn();
const s3Send = vi.fn();
const cloudfrontSend = vi.fn();
const getSignedUrl = vi.fn();

// The SDK entry points are constructed with `new`, so the stubs are classes.
vi.mock('google-auth-library', () => ({
	OAuth2Client: class {
		verifyIdToken = verifyIdToken;
	}
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
	DynamoDBClient: class {}
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
	DynamoDBDocumentClient: { from: () => ({ send }) },
	QueryCommand: class {
		__command = 'Query';
		constructor(public input: Record<string, unknown>) {}
	},
	TransactWriteCommand: class {
		__command = 'TransactWrite';
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
	HeadObjectCommand: class {
		__command = 'HeadObject';
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

function event(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
	return { headers: {}, ...overrides } as APIGatewayProxyEventV2;
}

function bodyOf(result: unknown): any {
	return JSON.parse((result as { body: string }).body);
}

function statusOf(result: unknown): number {
	return (result as { statusCode: number }).statusCode;
}

describe('resolveGoogleIdentity', () => {
	beforeEach(() => {
		vi.resetModules();
		verifyIdToken.mockReset();
		process.env.GOOGLE_CLIENT_ID = 'test-client-id';
	});

	afterEach(() => {
		delete process.env.GOOGLE_CLIENT_ID;
	});

	it('resolves a valid google id token to a participant key', async () => {
		verifyIdToken.mockResolvedValue({
			getPayload: () => ({ sub: '1234567890', name: 'Alex Example' })
		});
		const { resolveGoogleIdentity } = await loadLambda();

		expect(await resolveGoogleIdentity('valid-token')).toEqual({
			ok: true,
			participantKey: 'google:1234567890',
			name: 'Alex Example',
			email: '',
			emailVerified: false
		});
	});

	it('verifies the token against the configured audience', async () => {
		verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: '1', name: 'Alex' }) });
		const { resolveGoogleIdentity } = await loadLambda();

		await resolveGoogleIdentity('valid-token');

		expect(verifyIdToken).toHaveBeenCalledWith({
			idToken: 'valid-token',
			audience: 'test-client-id'
		});
	});

	it('prefers the client-supplied display name over the google profile name', async () => {
		verifyIdToken.mockResolvedValue({
			getPayload: () => ({ sub: '1234567890', name: 'Alex Example' })
		});
		const { resolveGoogleIdentity } = await loadLambda();

		expect(await resolveGoogleIdentity('valid-token', 'Max')).toMatchObject({ name: 'Max' });
	});

	it('falls back to the google profile name when no client name is given', async () => {
		verifyIdToken.mockResolvedValue({
			getPayload: () => ({ sub: '1234567890', name: 'Alex Example' })
		});
		const { resolveGoogleIdentity } = await loadLambda();

		expect(await resolveGoogleIdentity('valid-token', '')).toMatchObject({
			name: 'Alex Example'
		});
	});

	it('truncates an over-long display name', async () => {
		verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: '1', name: 'Alex' }) });
		const { resolveGoogleIdentity } = await loadLambda();

		const identity = await resolveGoogleIdentity('valid-token', 'x'.repeat(80));

		expect(identity.ok && identity.name).toHaveLength(50);
	});

	it('rejects a token with no name on the payload and no client name given', async () => {
		verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: '1234567890', name: '' }) });
		const { resolveGoogleIdentity } = await loadLambda();

		expect(await resolveGoogleIdentity('valid-token')).toEqual({
			ok: false,
			statusCode: 401,
			error: 'Google profile name is missing'
		});
	});

	it('rejects a payload without a subject', async () => {
		verifyIdToken.mockResolvedValue({ getPayload: () => ({ name: 'Alex' }) });
		const { resolveGoogleIdentity } = await loadLambda();

		expect(await resolveGoogleIdentity('valid-token')).toEqual({
			ok: false,
			statusCode: 401,
			error: 'Invalid Google identity'
		});
	});

	it('rejects an invalid or expired token and logs the underlying error', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const underlyingError = new Error('Token used too late');
		verifyIdToken.mockRejectedValue(underlyingError);
		const { resolveGoogleIdentity } = await loadLambda();

		expect(await resolveGoogleIdentity('bad-token')).toEqual({
			ok: false,
			statusCode: 401,
			error: 'Invalid Google token'
		});
		expect(consoleError).toHaveBeenCalledWith(
			'Google ID token verification failed:',
			underlyingError
		);
		consoleError.mockRestore();
	});

	it('returns a 500 when GOOGLE_CLIENT_ID is not configured', async () => {
		delete process.env.GOOGLE_CLIENT_ID;
		const { resolveGoogleIdentity } = await loadLambda();

		expect(await resolveGoogleIdentity('any-token')).toEqual({
			ok: false,
			statusCode: 500,
			error: 'Google auth not configured'
		});
	});
});

describe('validatePutBody', () => {
	beforeEach(() => {
		vi.resetModules();
		process.env.GOOGLE_CLIENT_ID = 'test-client-id';
	});

	it('accepts a well-formed body and trims the name', async () => {
		const { validatePutBody } = await loadLambda();

		const result = validatePutBody(
			JSON.stringify({
				googleIdToken: 'tok',
				name: '  Alex  ',
				color: '#e74c3c',
				selections: { a: 1 }
			})
		);

		expect(result.data).toEqual({
			googleIdToken: 'tok',
			name: 'Alex',
			color: '#e74c3c',
			selections: { a: 1 }
		});
	});

	it.each([
		['invalid json', '{not json', /invalid json/i],
		['a missing token', JSON.stringify({ color: '#e74c3c', selections: {} }), /googleidtoken/i],
		[
			'a malformed colour',
			JSON.stringify({ googleIdToken: 't', color: 'red', selections: {} }),
			/hex color/i
		],
		[
			'selections that are not an object',
			JSON.stringify({ googleIdToken: 't', color: '#e74c3c', selections: [1] }),
			/must be an object/i
		],
		[
			'an out-of-range selection value',
			JSON.stringify({ googleIdToken: 't', color: '#e74c3c', selections: { a: 3 } }),
			/0, 1, or 2/
		],
		[
			'an over-long selection key',
			JSON.stringify({
				googleIdToken: 't',
				color: '#e74c3c',
				selections: { ['x'.repeat(101)]: 1 }
			}),
			/invalid selection key/i
		],
		[
			'a non-string name',
			JSON.stringify({ googleIdToken: 't', color: '#e74c3c', selections: {}, name: 5 }),
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
			validatePutBody(JSON.stringify({ googleIdToken: 't', color: '#e74c3c', selections })).error
		).toMatch(/too many selections/i);
	});

	it('rejects a selections map that would exceed the DynamoDB item limit', async () => {
		const { validatePutBody } = await loadLambda();
		// Few enough entries to pass the count check, but long keys make it oversized.
		const selections = Object.fromEntries(
			Array.from({ length: 4000 }, (_, index) => [`${index}`.padEnd(100, 'x'), 1])
		);

		expect(
			validatePutBody(JSON.stringify({ googleIdToken: 't', color: '#e74c3c', selections })).error
		).toMatch(/too large/i);
	});
});

describe('handler', () => {
	beforeEach(() => {
		vi.resetModules();
		verifyIdToken.mockReset();
		send.mockReset();
		process.env.GOOGLE_CLIENT_ID = 'test-client-id';
		process.env.TABLE_NAME = 'stagehopper-selections';
		process.env.MEMBERSHIPS_TABLE_NAME = 'stagehopper-room-memberships';
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
		verifyIdToken.mockResolvedValue({
			getPayload: () => ({ sub: '1234567890', name: 'Alex Example' })
		});
	});

	afterEach(() => {
		delete process.env.GOOGLE_CLIENT_ID;
		delete process.env.TABLE_NAME;
		delete process.env.MEMBERSHIPS_TABLE_NAME;
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
	});

	describe('reading selections', () => {
		it('queries the room partition', async () => {
			send.mockResolvedValue({ Items: [{ userId: 'google:1' }] });
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'GET /api/stagehopper/rooms/{roomId}/selections',
					pathParameters: { roomId: 'tmr26-abc123' }
				})
			);

			expect(bodyOf(res)).toEqual([{ userId: 'google:1' }]);
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
				putEvent({ name: 'Alex', color: '#e74c3c', selections: {}, googleIdToken: 'tok' })
			);

			expect(statusOf(res)).toBe(200);
			const items = commandsOfType('TransactWrite')[0]?.input.TransactItems;
			expect(items).toHaveLength(2);
			expect(
				items.find((item: any) => item.Put.TableName === 'stagehopper-selections').Put.Item
			).toMatchObject({
				roomId: 'tmr26-abc123',
				userId: 'google:1234567890',
				name: 'Alex',
				color: '#e74c3c'
			});
			const membership = items.find(
				(item: any) => item.Put.TableName === 'stagehopper-room-memberships'
			).Put;
			expect(membership.Item).toMatchObject({
				userId: 'google:1234567890',
				roomId: 'tmr26-abc123',
				name: 'Alex',
				color: '#e74c3c'
			});
			expect(typeof membership.Item.updatedAt).toBe('number');
		});

		it('stores the verified identity, not a client-claimed user id', async () => {
			send.mockResolvedValue({});
			const { handler } = await loadLambda();

			await handler(
				putEvent({
					name: 'Alex',
					color: '#e74c3c',
					selections: {},
					googleIdToken: 'tok',
					userId: 'google:someone-else'
				})
			);

			const items = commandsOfType('TransactWrite')[0]?.input.TransactItems;
			expect(items[0].Put.Item.userId).toBe('google:1234567890');
		});

		it('rejects a write with an expired token before touching DynamoDB', async () => {
			verifyIdToken.mockRejectedValue(new Error('Token used too late'));
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const { handler } = await loadLambda();

			const res = await handler(
				putEvent({ name: 'Alex', color: '#e74c3c', selections: {}, googleIdToken: 'expired' })
			);

			expect(statusOf(res)).toBe(401);
			expect(send).not.toHaveBeenCalled();
			consoleError.mockRestore();
		});

		it('rejects a write to an invalid room id', async () => {
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'PUT /api/stagehopper/rooms/{roomId}/selections',
					pathParameters: { roomId: '!!' },
					body: JSON.stringify({ color: '#e74c3c', selections: {}, googleIdToken: 'tok' })
				})
			);

			expect(statusOf(res)).toBe(400);
		});
	});

	describe('listing rooms', () => {
		it("lists a user's rooms sorted by most recently active", async () => {
			send.mockResolvedValue({
				Items: [
					{ roomId: 'tmr26-aaa111', updatedAt: 5 },
					{ roomId: 'tmr26-bbb222', updatedAt: 10 }
				]
			});
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'POST /api/stagehopper/users/me/rooms',
					body: JSON.stringify({ googleIdToken: 'tok' })
				})
			);

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual([
				{ roomId: 'tmr26-bbb222', updatedAt: 10 },
				{ roomId: 'tmr26-aaa111', updatedAt: 5 }
			]);
			expect(commandsOfType('Query')[0]?.input.TableName).toBe('stagehopper-room-memberships');
		});

		it("follows LastEvaluatedKey to collect every page of a user's rooms", async () => {
			send
				.mockResolvedValueOnce({
					Items: [{ roomId: 'tmr26-aaa111', updatedAt: 5 }],
					LastEvaluatedKey: { userId: 'google:1234567890', roomId: 'tmr26-aaa111' }
				})
				.mockResolvedValueOnce({ Items: [{ roomId: 'tmr26-bbb222', updatedAt: 10 }] });
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'POST /api/stagehopper/users/me/rooms',
					body: JSON.stringify({ googleIdToken: 'tok' })
				})
			);

			expect(bodyOf(res)).toEqual([
				{ roomId: 'tmr26-bbb222', updatedAt: 10 },
				{ roomId: 'tmr26-aaa111', updatedAt: 5 }
			]);
			const queries = commandsOfType('Query');
			expect(queries).toHaveLength(2);
			expect(queries[1]?.input.ExclusiveStartKey).toEqual({
				userId: 'google:1234567890',
				roomId: 'tmr26-aaa111'
			});
		});

		it('lists rooms even when the Google token has no name claim', async () => {
			verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: '1234567890', name: '' }) });
			send.mockResolvedValue({ Items: [] });
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'POST /api/stagehopper/users/me/rooms',
					body: JSON.stringify({ googleIdToken: 'tok' })
				})
			);

			expect(statusOf(res)).toBe(200);
		});

		it('rejects listing rooms without a googleIdToken', async () => {
			const { handler } = await loadLambda();

			const res = await handler(
				event({ routeKey: 'POST /api/stagehopper/users/me/rooms', body: JSON.stringify({}) })
			);

			expect(statusOf(res)).toBe(400);
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
					body: JSON.stringify({ googleIdToken: 'tok' })
				})
			);

			expect(statusOf(res)).toBe(200);
			const items = commandsOfType('TransactWrite')[0]?.input.TransactItems;
			expect(items).toHaveLength(2);
			expect(items).toContainEqual({
				Delete: {
					TableName: 'stagehopper-selections',
					Key: { roomId: 'tmr26-abc123', userId: 'google:1234567890' }
				}
			});
			expect(items).toContainEqual({
				Delete: {
					TableName: 'stagehopper-room-memberships',
					Key: { userId: 'google:1234567890', roomId: 'tmr26-abc123' }
				}
			});
		});

		it('leaves a room even when the Google token has no name claim', async () => {
			verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: '1234567890', name: '' }) });
			send.mockResolvedValue({});
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'DELETE /api/stagehopper/rooms/{roomId}/selections',
					pathParameters: { roomId: 'tmr26-abc123' },
					body: JSON.stringify({ googleIdToken: 'tok' })
				})
			);

			expect(statusOf(res)).toBe(200);
		});

		it('rejects leaving a room with an invalid roomId', async () => {
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'DELETE /api/stagehopper/rooms/{roomId}/selections',
					pathParameters: { roomId: '!!' },
					body: JSON.stringify({ googleIdToken: 'tok' })
				})
			);

			expect(statusOf(res)).toBe(400);
		});

		it('rejects leaving a room without a googleIdToken', async () => {
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'DELETE /api/stagehopper/rooms/{roomId}/selections',
					pathParameters: { roomId: 'tmr26-abc123' },
					body: JSON.stringify({})
				})
			);

			expect(statusOf(res)).toBe(400);
			expect(send).not.toHaveBeenCalled();
		});
	});
});

describe('admin gate', () => {
	beforeEach(() => {
		vi.resetModules();
		verifyIdToken.mockReset();
		send.mockReset();
		process.env.GOOGLE_CLIENT_ID = 'test-client-id';
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
		process.env.ADMIN_EMAILS = 'boss@example.com,second@example.com';
	});

	afterEach(() => {
		delete process.env.GOOGLE_CLIENT_ID;
		delete process.env.SITE_ORIGIN;
		delete process.env.ADMIN_EMAILS;
	});

	/** Resolve the next token verification to a Google payload with these claims. */
	function signedInAs(claims: Record<string, unknown>) {
		verifyIdToken.mockResolvedValue({
			getPayload: () => ({ sub: '1234567890', name: 'Alex Example', ...claims })
		});
	}

	/** Call `POST /admin/me` with a token, after the module has read the current env. */
	async function adminMe(body: unknown = { googleIdToken: 'tok' }) {
		const { handler } = await loadLambda();
		return handler(
			event({ routeKey: 'POST /api/stagehopper/admin/me', body: JSON.stringify(body) })
		);
	}

	it('admits an allowlisted address with a verified email', async () => {
		signedInAs({ email: 'boss@example.com', email_verified: true });

		const res = await adminMe();

		expect(statusOf(res)).toBe(200);
		expect(bodyOf(res)).toEqual({ isAdmin: true });
	});

	// The claim is attacker-controlled without Google's own verification: anyone can put
	// an admin's address on an account they own. This is the test the whole gate rests on.
	it('refuses an allowlisted address whose email is unverified', async () => {
		signedInAs({ email: 'boss@example.com', email_verified: false });

		const res = await adminMe();

		expect(statusOf(res)).toBe(403);
		expect(bodyOf(res)).toMatchObject({ isAdmin: false });
	});

	it('refuses an allowlisted address with no email_verified claim at all', async () => {
		signedInAs({ email: 'boss@example.com' });

		expect(statusOf(await adminMe())).toBe(403);
	});

	it('refuses a truthy but non-boolean email_verified claim', async () => {
		signedInAs({ email: 'boss@example.com', email_verified: 'true' });

		expect(statusOf(await adminMe())).toBe(403);
	});

	// 403 rather than 401: the token is valid, so the client has nothing to re-auth into
	// and would otherwise loop through Google sign-in forever.
	it('answers 403, not 401, for a verified address that is not on the list', async () => {
		signedInAs({ email: 'someone@example.com', email_verified: true });

		const res = await adminMe();

		expect(statusOf(res)).toBe(403);
		expect(bodyOf(res)).toMatchObject({ isAdmin: false });
	});

	it('answers 401 for a token that does not verify', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		verifyIdToken.mockRejectedValue(new Error('Token used too late'));

		expect(statusOf(await adminMe())).toBe(401);
		consoleError.mockRestore();
	});

	it('answers 400 when no token is supplied', async () => {
		expect(statusOf(await adminMe({}))).toBe(400);
		expect(verifyIdToken).not.toHaveBeenCalled();
	});

	it('admits nobody when ADMIN_EMAILS is empty, including a formerly valid admin', async () => {
		process.env.ADMIN_EMAILS = '';
		signedInAs({ email: 'boss@example.com', email_verified: true });

		expect(statusOf(await adminMe())).toBe(403);
	});

	it('admits nobody when ADMIN_EMAILS is unset', async () => {
		delete process.env.ADMIN_EMAILS;
		signedInAs({ email: 'boss@example.com', email_verified: true });

		expect(statusOf(await adminMe())).toBe(403);
	});

	it('warns once at cold start when no allowlist is configured', async () => {
		delete process.env.ADMIN_EMAILS;
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		await loadLambda();

		expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('ADMIN_EMAILS'));
		consoleWarn.mockRestore();
	});

	it('ignores case and padding in both the env list and the token claim', async () => {
		process.env.ADMIN_EMAILS = '  BOSS@Example.com , ,second@example.com  ';
		signedInAs({ email: ' Boss@EXAMPLE.com ', email_verified: true });

		expect(statusOf(await adminMe())).toBe(200);
	});

	it('refuses a verified token that carries no email claim', async () => {
		signedInAs({ email_verified: true });

		expect(statusOf(await adminMe())).toBe(403);
	});

	it('reads no data to answer', async () => {
		signedInAs({ email: 'boss@example.com', email_verified: true });

		await adminMe();

		expect(send).not.toHaveBeenCalled();
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
			accent: 'red',
			emoji: '🎪',
			...overrides
		};
	}

	beforeEach(() => {
		vi.resetModules();
		verifyIdToken.mockReset();
		s3Send.mockReset().mockResolvedValue({});
		cloudfrontSend.mockReset().mockResolvedValue({});
		process.env.GOOGLE_CLIENT_ID = 'test-client-id';
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
		process.env.ADMIN_EMAILS = 'boss@example.com';
		process.env.SITE_BUCKET = 'stagehopper-radomskyi-com';
		process.env.CF_DISTRIBUTION_ID = 'EDFDVBD6EXAMPLE';
		verifyIdToken.mockResolvedValue({
			getPayload: () => ({
				sub: '1',
				name: 'Boss',
				email: 'boss@example.com',
				email_verified: true
			})
		});
	});

	afterEach(() => {
		delete process.env.GOOGLE_CLIENT_ID;
		delete process.env.SITE_ORIGIN;
		delete process.env.ADMIN_EMAILS;
		delete process.env.SITE_BUCKET;
		delete process.env.CF_DISTRIBUTION_ID;
	});

	async function putFestivals(body: unknown) {
		const { handler } = await loadLambda();
		return handler(
			event({ routeKey: 'PUT /api/stagehopper/admin/festivals', body: JSON.stringify(body) })
		);
	}

	describe('validateFestivalsBody', () => {
		it('accepts a well-formed list', async () => {
			const { validateFestivalsBody } = await loadLambda();

			const result = validateFestivalsBody(
				JSON.stringify({ googleIdToken: 'tok', festivals: [validRecord()] })
			);

			expect(result.error).toBeUndefined();
			expect(result.data?.festivals).toEqual([validRecord()]);
		});

		it.each([
			['a missing token', { festivals: [validRecord()] }, /googleidtoken/i],
			['a non-array festivals field', { googleIdToken: 't', festivals: {} }, /must be an array/i],
			['an empty list', { googleIdToken: 't', festivals: [] }, /must not be empty/i],
			[
				'an id that is too long',
				{ googleIdToken: 't', festivals: [validRecord({ id: 'x'.repeat(11) })] },
				/festival id/i
			],
			[
				'an id with uppercase letters',
				{ googleIdToken: 't', festivals: [validRecord({ id: 'NewFest26' })] },
				/festival id/i
			],
			[
				'a blank name',
				{ googleIdToken: 't', festivals: [validRecord({ name: '  ' })] },
				/name is required/i
			],
			[
				'a malformed startDate',
				{ googleIdToken: 't', festivals: [validRecord({ startDate: '08/01/2026' })] },
				/startDate/
			],
			[
				'an endDate before the startDate',
				{
					googleIdToken: 't',
					festivals: [validRecord({ startDate: '2026-08-10', endDate: '2026-08-01' })]
				},
				/startDate must not be after endDate/i
			],
			[
				'a non-string imageUrl',
				{ googleIdToken: 't', festivals: [validRecord({ imageUrl: 5 })] },
				/imageUrl must be a string/i
			],
			[
				'duplicate ids',
				{ googleIdToken: 't', festivals: [validRecord(), validRecord()] },
				/duplicate festival id/i
			]
		])('rejects %s', async (_label, body, expected) => {
			const { validateFestivalsBody } = await loadLambda();

			expect(validateFestivalsBody(JSON.stringify(body)).error).toMatch(expected);
		});
	});

	describe('PUT /admin/festivals', () => {
		it('writes the list to S3 and invalidates the CloudFront path', async () => {
			const res = await putFestivals({ googleIdToken: 'tok', festivals: [validRecord()] });

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({ ok: true, festivals: [validRecord()] });

			const [putCommand] = s3Send.mock.calls[0] as [
				{ input: { Bucket: string; Key: string; Body: string; ContentType: string } }
			];
			expect(putCommand.input).toMatchObject({
				Bucket: 'stagehopper-radomskyi-com',
				Key: 'data/festivals.json',
				ContentType: 'application/json'
			});
			expect(JSON.parse(putCommand.input.Body)).toEqual([validRecord()]);

			const [invalidateCommand] = cloudfrontSend.mock.calls[0] as [
				{ input: { DistributionId: string; InvalidationBatch: { Paths: { Items: string[] } } } }
			];
			expect(invalidateCommand.input.DistributionId).toBe('EDFDVBD6EXAMPLE');
			expect(invalidateCommand.input.InvalidationBatch.Paths.Items).toEqual([
				'/data/festivals.json'
			]);
		});

		it('refuses a non-admin, verified account', async () => {
			verifyIdToken.mockResolvedValue({
				getPayload: () => ({
					sub: '2',
					name: 'Someone',
					email: 'someone@example.com',
					email_verified: true
				})
			});

			const res = await putFestivals({ googleIdToken: 'tok', festivals: [validRecord()] });

			expect(statusOf(res)).toBe(403);
			expect(s3Send).not.toHaveBeenCalled();
		});

		it('refuses an unverified email even if it is on the allowlist', async () => {
			verifyIdToken.mockResolvedValue({
				getPayload: () => ({
					sub: '1',
					name: 'Boss',
					email: 'boss@example.com',
					email_verified: false
				})
			});

			const res = await putFestivals({ googleIdToken: 'tok', festivals: [validRecord()] });

			expect(statusOf(res)).toBe(403);
			expect(s3Send).not.toHaveBeenCalled();
		});

		it('rejects a malformed body before checking identity', async () => {
			const res = await putFestivals({
				googleIdToken: 'tok',
				festivals: [validRecord({ id: '' })]
			});

			expect(statusOf(res)).toBe(400);
			expect(verifyIdToken).not.toHaveBeenCalled();
			expect(s3Send).not.toHaveBeenCalled();
		});

		it('answers 500 when the S3 write fails', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			s3Send.mockRejectedValue(new Error('access denied'));

			const res = await putFestivals({ googleIdToken: 'tok', festivals: [validRecord()] });

			expect(statusOf(res)).toBe(500);
			consoleError.mockRestore();
		});

		it('still reports success when the write lands but the invalidation fails', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			cloudfrontSend.mockRejectedValue(new Error('rate limited'));

			const res = await putFestivals({ googleIdToken: 'tok', festivals: [validRecord()] });

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toMatchObject({ ok: true });
			consoleError.mockRestore();
		});

		it('skips the invalidation when no distribution is configured', async () => {
			delete process.env.CF_DISTRIBUTION_ID;

			const res = await putFestivals({ googleIdToken: 'tok', festivals: [validRecord()] });

			expect(statusOf(res)).toBe(200);
			expect(cloudfrontSend).not.toHaveBeenCalled();
		});
	});
});

describe('generalized room id regex', () => {
	beforeEach(() => {
		vi.resetModules();
		verifyIdToken.mockReset();
		send.mockReset().mockResolvedValue({ Items: [] });
		process.env.GOOGLE_CLIENT_ID = 'test-client-id';
		process.env.TABLE_NAME = 'stagehopper-selections';
		process.env.MEMBERSHIPS_TABLE_NAME = 'stagehopper-room-memberships';
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
	});

	afterEach(() => {
		delete process.env.GOOGLE_CLIENT_ID;
		delete process.env.TABLE_NAME;
		delete process.env.MEMBERSHIPS_TABLE_NAME;
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
		verifyIdToken.mockReset();
		s3Send.mockReset();
		getSignedUrl.mockReset().mockResolvedValue('https://s3.example/presigned-put');
		process.env.GOOGLE_CLIENT_ID = 'test-client-id';
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
		process.env.ADMIN_EMAILS = 'boss@example.com';
		process.env.SITE_BUCKET = 'stagehopper-radomskyi-com';
		verifyIdToken.mockResolvedValue({
			getPayload: () => ({
				sub: '1',
				name: 'Boss',
				email: 'boss@example.com',
				email_verified: true
			})
		});
	});

	afterEach(() => {
		delete process.env.GOOGLE_CLIENT_ID;
		delete process.env.SITE_ORIGIN;
		delete process.env.ADMIN_EMAILS;
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
		const res = await presign({ googleIdToken: 'tok', contentType: 'image/jpeg', contentLength: 500_000 });

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
		const pngRes = await presign({ googleIdToken: 'tok', contentType: 'image/png', contentLength: 1000 });
		expect(bodyOf(pngRes).imageUrl).toMatch(/\.png$/);

		const webpRes = await presign({ googleIdToken: 'tok', contentType: 'image/webp', contentLength: 1000 });
		expect(bodyOf(webpRes).imageUrl).toMatch(/\.webp$/);
	});

	it('gives two uploads for the same festival different keys', async () => {
		const first = await presign({ googleIdToken: 'tok', contentType: 'image/jpeg', contentLength: 1000 });
		const second = await presign({ googleIdToken: 'tok', contentType: 'image/jpeg', contentLength: 1000 });

		expect(bodyOf(first).imageUrl).not.toBe(bodyOf(second).imageUrl);
	});

	it('rejects a disallowed content type before checking identity', async () => {
		const res = await presign({ googleIdToken: 'tok', contentType: 'image/gif', contentLength: 1000 });

		expect(statusOf(res)).toBe(400);
		expect(verifyIdToken).not.toHaveBeenCalled();
		expect(getSignedUrl).not.toHaveBeenCalled();
	});

	it('rejects a non-image content type', async () => {
		const res = await presign({
			googleIdToken: 'tok',
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
		const res = await presign({ googleIdToken: 'tok', contentType: 'image/jpeg', contentLength });

		expect(statusOf(res)).toBe(400);
		expect(getSignedUrl).not.toHaveBeenCalled();
	});

	it('rejects a non-numeric contentLength', async () => {
		const res = await presign({ googleIdToken: 'tok', contentType: 'image/jpeg', contentLength: '500000' });

		expect(statusOf(res)).toBe(400);
	});

	it('rejects a malformed festival id', async () => {
		const res = await presign(
			{ googleIdToken: 'tok', contentType: 'image/jpeg', contentLength: 1000 },
			'Not An Id'
		);

		expect(statusOf(res)).toBe(400);
		expect(verifyIdToken).not.toHaveBeenCalled();
	});

	it('refuses a non-admin, verified account', async () => {
		verifyIdToken.mockResolvedValue({
			getPayload: () => ({
				sub: '2',
				name: 'Someone',
				email: 'someone@example.com',
				email_verified: true
			})
		});

		const res = await presign({ googleIdToken: 'tok', contentType: 'image/jpeg', contentLength: 1000 });

		expect(statusOf(res)).toBe(403);
		expect(getSignedUrl).not.toHaveBeenCalled();
	});

	it('refuses an unverified email even if it is on the allowlist', async () => {
		verifyIdToken.mockResolvedValue({
			getPayload: () => ({
				sub: '1',
				name: 'Boss',
				email: 'boss@example.com',
				email_verified: false
			})
		});

		const res = await presign({ googleIdToken: 'tok', contentType: 'image/jpeg', contentLength: 1000 });

		expect(statusOf(res)).toBe(403);
		expect(getSignedUrl).not.toHaveBeenCalled();
	});

	it('answers 401 for a token that does not verify', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		verifyIdToken.mockRejectedValue(new Error('Token used too late'));

		const res = await presign({ googleIdToken: 'tok', contentType: 'image/jpeg', contentLength: 1000 });

		expect(statusOf(res)).toBe(401);
		consoleError.mockRestore();
	});

	it('answers 500 when presigning fails', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		getSignedUrl.mockRejectedValue(new Error('signing error'));

		const res = await presign({ googleIdToken: 'tok', contentType: 'image/jpeg', contentLength: 1000 });

		expect(statusOf(res)).toBe(500);
		consoleError.mockRestore();
	});
});

describe('admin: timetable import', () => {
	/** The stored/canonical shape — ids present, as `validateTimetableImportPayload` requires. */
	function storedTimetable(overrides: Record<string, unknown> = {}) {
		return {
			formatVersion: 1,
			festivalId: 'tmr26',
			days: [
				{
					date: '2026-07-17',
					performances: [
						{ id: 'p1', artist: 'A', stage: 'MAIN', startTime: '22:00', endTime: '23:00' }
					]
				}
			],
			...overrides
		};
	}

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

	/** S3's shape for "the object doesn't exist" — matches the real SDK's NotFound error. */
	const notFoundError = Object.assign(new Error('NotFound'), {
		name: 'NotFound',
		$metadata: { httpStatusCode: 404 }
	});

	beforeEach(() => {
		vi.resetModules();
		verifyIdToken.mockReset();
		s3Send.mockReset();
		cloudfrontSend.mockReset().mockResolvedValue({});
		process.env.GOOGLE_CLIENT_ID = 'test-client-id';
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
		process.env.ADMIN_EMAILS = 'boss@example.com';
		process.env.SITE_BUCKET = 'stagehopper-radomskyi-com';
		process.env.CF_DISTRIBUTION_ID = 'EDFDVBD6EXAMPLE';
		verifyIdToken.mockResolvedValue({
			getPayload: () => ({
				sub: '1',
				name: 'Boss',
				email: 'boss@example.com',
				email_verified: true
			})
		});
	});

	afterEach(() => {
		delete process.env.GOOGLE_CLIENT_ID;
		delete process.env.SITE_ORIGIN;
		delete process.env.ADMIN_EMAILS;
		delete process.env.SITE_BUCKET;
		delete process.env.CF_DISTRIBUTION_ID;
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

	describe('validateTimetableImportPayload (stored shape — ids required)', () => {
		it('accepts a well-formed timetable', async () => {
			const { validateTimetableImportPayload } = await loadLambda();

			const result = validateTimetableImportPayload(storedTimetable());

			expect(result.error).toBeUndefined();
			expect(result.data).toEqual(storedTimetable());
		});

		it.each([
			['a non-object payload', 'not an object', /must be an object/i],
			['the wrong formatVersion', storedTimetable({ formatVersion: 2 }), /formatVersion must be 1/i],
			['a missing festivalId', storedTimetable({ festivalId: '' }), /festivalId is required/i],
			['an empty days array', storedTimetable({ days: [] }), /non-empty array/i],
			[
				'a malformed day date',
				storedTimetable({ days: [{ date: '17-07-2026', performances: [] }] }),
				/ISO date/i
			],
			[
				'a missing performance id',
				storedTimetable({
					days: [
						{
							date: '2026-07-17',
							performances: [{ artist: 'A', stage: 'MAIN', startTime: '22:00', endTime: '23:00' }]
						}
					]
				}),
				/needs an id/i
			],
			[
				'a bad HH:MM startTime',
				storedTimetable({
					days: [
						{
							date: '2026-07-17',
							performances: [
								{ id: 'p1', artist: 'A', stage: 'MAIN', startTime: '10pm', endTime: '23:00' }
							]
						}
					]
				}),
				/startTime must be HH:MM/i
			],
			[
				'duplicate performance ids across days',
				storedTimetable({
					days: [
						{
							date: '2026-07-17',
							performances: [
								{ id: 'dup', artist: 'A', stage: 'MAIN', startTime: '22:00', endTime: '23:00' }
							]
						},
						{
							date: '2026-07-18',
							performances: [
								{ id: 'dup', artist: 'B', stage: 'MAIN', startTime: '20:00', endTime: '21:00' }
							]
						}
					]
				}),
				/duplicate performance id/i
			]
		])('rejects %s', async (_label, payload, expected) => {
			const { validateTimetableImportPayload } = await loadLambda();

			expect(validateTimetableImportPayload(payload).error).toMatch(expected);
		});
	});

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
			s3Send.mockImplementation((command: { __command: string }) => {
				if (command.__command === 'HeadObject') return Promise.reject(notFoundError);
				return Promise.resolve({});
			});

			const res = await importTimetable({ googleIdToken: 'tok', timetable: uploadTimetable() });

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({ ok: true });

			const putCommand = s3Send.mock.calls
				.map(([command]) => command as MockCommand)
				.find((command) => command.__command === 'PutObject');
			expect(putCommand?.input).toMatchObject({
				Bucket: 'stagehopper-radomskyi-com',
				Key: 'data/timetable-tmr26.json',
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
				'/data/timetable-tmr26.json'
			]);
		});

		// This is the case a review comment on this feature specifically flagged: an
		// uploaded file must not be able to dictate its own performance ids, even by
		// accident (an old export, a hand-edited file with stale ids from elsewhere).
		it('ignores any id the uploaded file supplies and assigns its own', async () => {
			s3Send.mockImplementation((command: { __command: string }) => {
				if (command.__command === 'HeadObject') return Promise.reject(notFoundError);
				return Promise.resolve({});
			});
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

			await importTimetable({ googleIdToken: 'tok', timetable: withCallerId });

			const putCommand = s3Send.mock.calls
				.map(([command]) => command as MockCommand)
				.find((command) => command.__command === 'PutObject');
			const written = JSON.parse(String(putCommand?.input.Body));
			expect(written.days[0].performances[0].id).not.toBe('caller-supplied-id');
			expect(written.days[0].performances[0].id).toMatch(/^[0-9a-f]{6}$/);
		});

		it('assigns a distinct id to every performance, across days', async () => {
			s3Send.mockImplementation((command: { __command: string }) => {
				if (command.__command === 'HeadObject') return Promise.reject(notFoundError);
				return Promise.resolve({});
			});
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

			await importTimetable({ googleIdToken: 'tok', timetable: manyPerformances });

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

		it('refuses to overwrite a timetable that already exists', async () => {
			s3Send.mockImplementation((command: { __command: string }) => {
				if (command.__command === 'HeadObject') return Promise.resolve({});
				return Promise.resolve({});
			});

			const res = await importTimetable({ googleIdToken: 'tok', timetable: uploadTimetable() });

			expect(statusOf(res)).toBe(409);
			const putCommands = s3Send.mock.calls
				.map(([command]) => command as MockCommand)
				.filter((command) => command.__command === 'PutObject');
			expect(putCommands).toHaveLength(0);
		});

		it('rejects a timetable whose festivalId does not match the target festival', async () => {
			const res = await importTimetable(
				{ googleIdToken: 'tok', timetable: uploadTimetable({ festivalId: 'ps26' }) },
				'tmr26'
			);

			expect(statusOf(res)).toBe(400);
			expect(verifyIdToken).not.toHaveBeenCalled();
			expect(s3Send).not.toHaveBeenCalled();
		});

		it('rejects a malformed festival id in the path', async () => {
			const res = await importTimetable(
				{ googleIdToken: 'tok', timetable: uploadTimetable() },
				'Not An Id'
			);

			expect(statusOf(res)).toBe(400);
			expect(verifyIdToken).not.toHaveBeenCalled();
		});

		it('rejects a request with no path parameters at all', async () => {
			const { handler } = await loadLambda();

			const res = await handler(
				event({
					routeKey: 'POST /api/stagehopper/admin/festivals/{id}/timetable-import',
					body: JSON.stringify({ googleIdToken: 'tok', timetable: uploadTimetable() })
				})
			);

			expect(statusOf(res)).toBe(400);
			expect(verifyIdToken).not.toHaveBeenCalled();
			expect(s3Send).not.toHaveBeenCalled();
		});

		it('rejects an invalid timetable before checking identity', async () => {
			const res = await importTimetable({ googleIdToken: 'tok', timetable: uploadTimetable({ days: [] }) });

			expect(statusOf(res)).toBe(400);
			expect(verifyIdToken).not.toHaveBeenCalled();
			expect(s3Send).not.toHaveBeenCalled();
		});

		it('refuses a non-admin, verified account', async () => {
			verifyIdToken.mockResolvedValue({
				getPayload: () => ({
					sub: '2',
					name: 'Someone',
					email: 'someone@example.com',
					email_verified: true
				})
			});

			const res = await importTimetable({ googleIdToken: 'tok', timetable: uploadTimetable() });

			expect(statusOf(res)).toBe(403);
			expect(s3Send).not.toHaveBeenCalled();
		});

		it('refuses an unverified email even if it is on the allowlist', async () => {
			verifyIdToken.mockResolvedValue({
				getPayload: () => ({
					sub: '1',
					name: 'Boss',
					email: 'boss@example.com',
					email_verified: false
				})
			});

			const res = await importTimetable({ googleIdToken: 'tok', timetable: uploadTimetable() });

			expect(statusOf(res)).toBe(403);
			expect(s3Send).not.toHaveBeenCalled();
		});

		it('answers 500 when checking for an existing timetable fails unexpectedly', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			s3Send.mockImplementation((command: { __command: string }) => {
				if (command.__command === 'HeadObject') return Promise.reject(new Error('access denied'));
				return Promise.resolve({});
			});

			const res = await importTimetable({ googleIdToken: 'tok', timetable: uploadTimetable() });

			expect(statusOf(res)).toBe(500);
			consoleError.mockRestore();
		});

		it('answers 500 when the S3 write fails', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			s3Send.mockImplementation((command: { __command: string }) => {
				if (command.__command === 'HeadObject') return Promise.reject(notFoundError);
				return Promise.reject(new Error('access denied'));
			});

			const res = await importTimetable({ googleIdToken: 'tok', timetable: uploadTimetable() });

			expect(statusOf(res)).toBe(500);
			consoleError.mockRestore();
		});

		it('still reports success when the write lands but the invalidation fails', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			s3Send.mockImplementation((command: { __command: string }) => {
				if (command.__command === 'HeadObject') return Promise.reject(notFoundError);
				return Promise.resolve({});
			});
			cloudfrontSend.mockRejectedValue(new Error('rate limited'));

			const res = await importTimetable({ googleIdToken: 'tok', timetable: uploadTimetable() });

			expect(statusOf(res)).toBe(200);
			consoleError.mockRestore();
		});
	});
});
