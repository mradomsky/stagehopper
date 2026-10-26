import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { readFileSync } from 'node:fs';
import { FESTIVAL_FIELD_NAMES } from '../shared/festival-fields.js';

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
 *
 * Admin routes get no default. The gateway only lets an `admin`-scoped token reach them, and
 * the handlers don't re-check (see `hasAdminScope`), so a test that fell back to
 * `USER_CLAIMS` would pass while describing a non-admin using the admin console. `/admin/me`
 * is exempt: it is the one admin route that is not scope-gated.
 */
function event(
	overrides: Partial<APIGatewayProxyEventV2> = {},
	claims?: Record<string, unknown> | null
): APIGatewayProxyEventV2 {
	if (claims === undefined) {
		const routeKey = overrides.routeKey ?? '';
		if (routeKey.includes('/api/stagehopper/admin/') && !routeKey.endsWith('/admin/me')) {
			throw new Error(`event(): pass claims explicitly for ${routeKey} — usually ADMIN_CLAIMS`);
		}
		claims = USER_CLAIMS;
	}
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
			usernameSeed: '',
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
			usernameSeed: '',
			email: '',
			scopes: []
		});
	});

	it('reads the Nickname seed from the username claim, trimmed', async () => {
		const { readIdentity } = await loadLambda();

		expect(readIdentity(event({}, { ...USER_CLAIMS, username: '  alex_h ' }))?.usernameSeed).toBe('alex_h');
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

describe('handler', () => {
	beforeEach(() => {
		vi.resetModules();
		send.mockReset();
		process.env.USERS_TABLE = 'stagehopper-users';
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
	});

	afterEach(() => {
		delete process.env.USERS_TABLE;
		delete process.env.SITE_ORIGIN;
	});

	it('answers preflight without a body', async () => {
		const { handler } = await loadLambda();

		const res = await handler(event({ routeKey: 'OPTIONS /api/stagehopper/festivals/tmr26/picks' }));

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
				routeKey: 'GET /api/stagehopper/festivals/{id}/picks',
				pathParameters: { id: 'tmr26' }
			})
		);

		expect(statusOf(res)).toBe(500);
		consoleError.mockRestore();
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
		process.env.USERS_TABLE = 'stagehopper-users';
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
	});

	afterEach(() => {
		delete process.env.USERS_TABLE;
		delete process.env.SITE_ORIGIN;
	});

	// API Gateway rejects an unauthenticated request before invoking this function, so none
	// of these are reachable in production. They are here because the failure mode if a
	// route is ever declared without `authorizer_id` is silent and severe: the handler would
	// write under `clerk:undefined` and hand one shared identity to every anonymous caller.
	// Answering 401 instead is what makes that misconfiguration visible rather than corrupting.
	const ROUTES: [string, Partial<APIGatewayProxyEventV2>][] = [
		['PUT /api/stagehopper/festivals/{id}/picks', {
			pathParameters: { id: 'tmr26' },
			body: JSON.stringify({ selections: {} })
		}],
		['GET /api/stagehopper/festivals/{id}/picks/me', { pathParameters: { id: 'tmr26' } }],
		['GET /api/stagehopper/admin/me', {}],
		['POST /api/stagehopper/users/me/notifications', { body: '{}' }],
		['POST /api/stagehopper/admin/users', { body: '{}' }],
		// Every route that opens with resolveAdminWrite — the six admin handlers across eight
		// route keys, plus the four notification routes that reach it through
		// resolveNotificationIdentity (the POST above is the first of those). One helper
		// decides fail-closed for all of them now, so the guard is worth stating on each
		// rather than on a sample.
		['PUT /api/stagehopper/users/me/notifications', { body: '{}' }],
		['POST /api/stagehopper/users/me/notifications/subscription', { body: '{}' }],
		['DELETE /api/stagehopper/users/me/notifications/subscription', { body: '{}' }],
		['POST /api/stagehopper/admin/festivals', { body: '{}' }],
		['PATCH /api/stagehopper/admin/festivals/{id}', {
			pathParameters: { id: 'tmr26' },
			body: '{}'
		}],
		['PATCH /api/stagehopper/admin/festivals/{id}/stage-order', {
			pathParameters: { id: 'tmr26' },
			body: '{}'
		}],
		['DELETE /api/stagehopper/admin/festivals/{id}', { pathParameters: { id: 'tmr26' } }],
		['POST /api/stagehopper/admin/festivals/{id}/image-upload', {
			pathParameters: { id: 'tmr26' },
			body: '{}'
		}],
		['POST /api/stagehopper/admin/festivals/{id}/map-upload', {
			pathParameters: { id: 'tmr26' },
			body: '{}'
		}],
		['POST /api/stagehopper/admin/festivals/{id}/timetable-import', {
			pathParameters: { id: 'tmr26' },
			body: '{}'
		}],
		['PATCH /api/stagehopper/admin/festivals/{id}/timetable', {
			pathParameters: { id: 'tmr26' },
			body: '{}'
		}]
	];

	it.each(ROUTES)('answers 401 on %s when no claims are attached', async (routeKey, rest) => {
		const { handler } = await loadLambda();

		const res = await handler(event({ routeKey, ...rest }, null));

		expect(statusOf(res)).toBe(401);
		expect(send).not.toHaveBeenCalled();
	});

	// On an admin route the router's scope gate runs before resolveAdminWrite, so the caller
	// is judged before the id's shape: a non-admin learns nothing about the route's input.
	// Every row sends the same bad id; only an admin gets far enough to be told it is bad.
	it.each([
		['no token', null, 401],
		['a user token', USER_CLAIMS, 403],
		['an admin token', ADMIN_CLAIMS, 400]
	] as const)(
		'with a malformed festival id, answers %s with %i: caller checked before input',
		async (_label, claims, status) => {
			const { handler } = await loadLambda();

			const res = await handler(
				event(
					{
						routeKey: 'PATCH /api/stagehopper/admin/festivals/{id}',
						pathParameters: { id: 'NOT VALID' },
						body: '{}'
					},
					claims
				)
			);

			expect(statusOf(res)).toBe(status);
			expect(send).not.toHaveBeenCalled();
		}
	);

	// The gateway's `authorization_scopes = ["admin"]` lives in another repo, so this is the
	// only place a non-admin reaching the admin surface can turn a test red (#159). The list
	// is read off the router itself: a route added later is covered without being listed.
	const ADMIN_ROUTE_KEYS = [
		...readFileSync('lambda/index.ts', 'utf8').matchAll(
			/case '([A-Z]+ \/api\/stagehopper\/admin\/[^']*)'/g
		)
	]
		.map(([, routeKey]) => routeKey)
		.filter((routeKey) => routeKey !== 'GET /api/stagehopper/admin/me');

	it('finds the admin routes to check', () => {
		// 14 today, one per `authorization_scopes` in the infra repo. A floor, so the regex
		// going blind fails rather than passing vacuously.
		expect(ADMIN_ROUTE_KEYS.length).toBeGreaterThanOrEqual(14);
	});

	it.each(ADMIN_ROUTE_KEYS)('answers 403 on %s to a signed-in non-admin', async (routeKey) => {
		const { handler } = await loadLambda();

		const res = await handler(
			event(
				{
					routeKey,
					pathParameters: { id: 'tmr26', userId: 'clerk:someone' },
					body: '{}'
				},
				USER_CLAIMS
			)
		);

		expect(statusOf(res)).toBe(403);
		for (const sdk of [send, s3Send, cloudfrontSend, lambdaSend, getSignedUrl]) {
			expect(sdk).not.toHaveBeenCalled();
		}
	});

	// A route that must keep working without any credential at all.
	it('still serves the public Picks read with no claims', async () => {
		send.mockResolvedValue({ Items: [] });
		const { handler } = await loadLambda();

		const res = await handler(
			event(
				{
					routeKey: 'GET /api/stagehopper/festivals/{id}/picks',
					pathParameters: { id: 'tmr26' }
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
		process.env.PICKS_TABLE = 'stagehopper-picks';
		process.env.MESSAGES_TABLE = 'stagehopper-messages';
	});

	afterEach(() => {
		delete process.env.MESSAGES_TABLE;
		delete process.env.SITE_ORIGIN;
		delete process.env.SITE_BUCKET;
		delete process.env.CF_DISTRIBUTION_ID;
		delete process.env.FESTIVALS_TABLE;
		delete process.env.PERFORMANCES_TABLE;
		delete process.env.PICKS_TABLE;
	});

	async function getFestivalsReq() {
		const { handler } = await loadLambda();
		return handler(event({ routeKey: 'GET /api/stagehopper/admin/festivals' }, ADMIN_CLAIMS));
	}

	async function createFestivalReq(body: unknown) {
		const { handler } = await loadLambda();
		return handler(
			event(
				{ routeKey: 'POST /api/stagehopper/admin/festivals', body: JSON.stringify(body) },
				ADMIN_CLAIMS
			)
		);
	}

	async function updateFestivalReq(festivalId: string, body: unknown) {
		const { handler } = await loadLambda();
		return handler(
			event(
				{
					routeKey: 'PATCH /api/stagehopper/admin/festivals/{id}',
					pathParameters: { id: festivalId },
					body: JSON.stringify(body)
				},
				ADMIN_CLAIMS
			)
		);
	}

	async function updateStageOrderReq(festivalId: string, body: unknown) {
		const { handler } = await loadLambda();
		return handler(
			event(
				{
					routeKey: 'PATCH /api/stagehopper/admin/festivals/{id}/stage-order',
					pathParameters: { id: festivalId },
					body: JSON.stringify(body)
				},
				ADMIN_CLAIMS
			)
		);
	}

	async function deleteFestivalReq(festivalId: string) {
		const { handler } = await loadLambda();
		return handler(
			event(
				{
					routeKey: 'DELETE /api/stagehopper/admin/festivals/{id}',
					pathParameters: { id: festivalId }
				},
				ADMIN_CLAIMS
			)
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
				...event({ routeKey: 'GET /api/stagehopper/admin/festivals' }, ADMIN_CLAIMS),
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

		// The whitelist test. Every field the schema declares must survive the round trip
		// into the published manifest; a field that is stored but never published is the
		// failure mode behind CLAUDE.md trap 3.
		it('republishes every schema field that is set on the record', async () => {
			const record = validRecord({
				imageUrl: '/data/festival-images/newfest26.jpg',
				mapUrl: '/data/festival-maps/newfest26-abc123.jpg',
				description: 'Three days of music on the beach.',
				stageColors: { 'Main Stage': '#3498db' },
				stageOrder: ['Main Stage'],
				isListedOnLanding: false
			});
			expect(Object.keys(record).sort()).toEqual([...FESTIVAL_FIELD_NAMES].sort());
			send.mockImplementation((command: MockCommand) => {
				if (command.__command === 'Scan') return Promise.resolve({ Items: [record] });
				return Promise.resolve({});
			});

			const res = await createFestivalReq(record);

			expect(statusOf(res)).toBe(201);
			const [manifestCommand] = s3Send.mock.calls[0] as [{ input: { Body: string } }];
			expect(JSON.parse(manifestCommand.input.Body)).toEqual([record]);
		});

		it('drops unknown attributes and skips malformed rows when publishing', async () => {
			const record = validRecord();
			send.mockImplementation((command: MockCommand) => {
				if (command.__command === 'Scan') {
					return Promise.resolve({
						Items: [{ ...record, internalNote: 'not public' }, { id: 'broken' }]
					});
				}
				return Promise.resolve({});
			});

			const res = await createFestivalReq(record);

			expect(statusOf(res)).toBe(201);
			const [manifestCommand] = s3Send.mock.calls[0] as [{ input: { Body: string } }];
			expect(JSON.parse(manifestCommand.input.Body)).toEqual([record]);
		});

		// The Festival page's Map menu entry reads this off the manifest, so leaving it out made
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
			],
			[
				'a non-boolean isListedOnLanding',
				validRecord({ isListedOnLanding: 'no' }),
				/isListedOnLanding must be a boolean/i
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

		it('rejects a non-boolean isListedOnLanding before writing anything', async () => {
			const res = await updateFestivalReq('newfest26', validRecord({ isListedOnLanding: 'no' }));

			expect(statusOf(res)).toBe(400);
			expect(bodyOf(res).error).toMatch(/isListedOnLanding must be a boolean/i);
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
				if (command.__command === 'Query' && command.input.TableName === 'stagehopper-messages') {
					return Promise.resolve({ Items: [{ messageId: '1700000000000-aaaaaaaa' }] });
				}
				if (command.__command === 'Query' && command.input.TableName === 'stagehopper-picks') {
					return Promise.resolve({ Items: [] });
				}
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

			const messageDeletes = commandsOfType('BatchWrite').flatMap(
				(c) => c.input.RequestItems['stagehopper-messages'] ?? []
			);
			expect(messageDeletes).toEqual([
				{ DeleteRequest: { Key: { festivalId: 'newfest26', messageId: '1700000000000-aaaaaaaa' } } }
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

	/**
	 * DynamoDB can accept a BatchWrite and hand part of it straight back as
	 * `UnprocessedItems` — a throttled request succeeds at the HTTP level while doing only
	 * some of the work. Nothing about that looks like an error, so a retry loop that drops
	 * the remainder strands rows silently: a deleted festival keeps some of its performances,
	 * and an import lands half a timetable.
	 *
	 * Reached through the delete route because the retry is module-private; the route is what
	 * a caller can actually observe it through.
	 */
	describe('BatchWrite retries', () => {
		/** Mirrors BATCH_MAX_ATTEMPTS in index.ts — how many passes the clock loop must allow. */
		const BATCH_ATTEMPT_LIMIT = 5;

		/**
		 * `deleteFestival` deletes the row, queries the festival's performance keys, then
		 * batch-deletes them. `batchResponses` are returned to successive BatchWrite calls;
		 * the last one repeats once the list runs out.
		 */
		function wireDelete(performanceIds: string[], batchResponses: Record<string, unknown>[]) {
			let batchCall = 0;
			send.mockImplementation((command: MockCommand) => {
				if (
					command.__command === 'Query' &&
					['stagehopper-picks', 'stagehopper-messages'].includes(command.input.TableName)
				) {
					return Promise.resolve({ Items: [] });
				}
				if (command.__command === 'Query') {
					return Promise.resolve({ Items: performanceIds.map((id) => ({ id })) });
				}
				if (command.__command === 'BatchWrite') {
					const response = batchResponses[Math.min(batchCall, batchResponses.length - 1)];
					batchCall++;
					return Promise.resolve(response ?? {});
				}
				return Promise.resolve({});
			});
		}

		const unprocessed = (ids: string[]) => ({
			UnprocessedItems: {
				'stagehopper-performances': ids.map((id) => ({
					DeleteRequest: { Key: { festivalId: 'newfest26', id } }
				}))
			}
		});

		function batchKeys(call: number, table = 'stagehopper-performances'): string[] {
			const command = commandsOfType('BatchWrite')[call];
			// Asserted rather than optional-chained: a missing call should read as "there was
			// no such request", not as a TypeError from mapping undefined.
			expect(command, `expected a BatchWrite call at index ${call}`).toBeDefined();
			const requests = (command!.input.RequestItems[table] ?? []) as {
				DeleteRequest: { Key: { id: string } };
			}[];
			return requests.map((request) => request.DeleteRequest.Key.id);
		}

		/** Held so it can be put back — a spy left on Math.random would follow the whole file. */
		let randomSpy: { mockRestore(): void };

		beforeEach(() => {
			// The backoff sleeps between attempts, so the clock has to be driven by the test
			// rather than waited on. Jitter is pinned so the delays are checkable.
			vi.useFakeTimers();
			randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
		});

		afterEach(() => {
			vi.useRealTimers();
			randomSpy.mockRestore();
		});

		/**
		 * Run the delete to completion, driving the backoff timers as they are scheduled.
		 *
		 * The module is imported *before* the handler is called, and the clock is driven in a
		 * loop rather than by one pass: `runAllTimersAsync` yields a single macrotask, so if
		 * the handler has not reached its first `setTimeout` by then it sees nothing pending,
		 * returns, and the delete waits on a clock nobody advances again. That fails as a
		 * five-second hang with no hint at the cause.
		 */
		async function runDelete() {
			const { handler } = await loadLambda();
			const pending = handler(
				event(
					{
						routeKey: 'DELETE /api/stagehopper/admin/festivals/{id}',
						pathParameters: { id: 'newfest26' }
					},
					ADMIN_CLAIMS
				)
			);

			let settled = false;
			void pending.then(() => (settled = true));
			for (let i = 0; i < BATCH_ATTEMPT_LIMIT && !settled; i++) {
				await vi.runAllTimersAsync();
			}
			return pending;
		}

		it('sends the first attempt without waiting on the clock', async () => {
			wireDelete(['p1'], [{}]);
			const { handler } = await loadLambda();

			const pending = handler(
				event(
					{
						routeKey: 'DELETE /api/stagehopper/admin/festivals/{id}',
						pathParameters: { id: 'newfest26' }
					},
					ADMIN_CLAIMS
				)
			);
			// No timers advanced: the first send must already have gone out, or every batch
			// write would pay a backoff it has not yet earned.
			await vi.advanceTimersByTimeAsync(0);
			expect(commandsOfType('BatchWrite')).toHaveLength(1);

			await vi.runAllTimersAsync();
			await pending;
		});

		it('retries only what came back unprocessed', async () => {
			wireDelete(['p1', 'p2', 'p3'], [unprocessed(['p2', 'p3']), {}]);

			const res = await runDelete();

			expect(statusOf(res)).toBe(200);
			expect(commandsOfType('BatchWrite')).toHaveLength(2);
			expect(batchKeys(0)).toEqual(['p1', 'p2', 'p3']);
			// Not the whole batch again: re-deleting p1 would be wasted, and on a put it
			// would rewrite a row the first attempt already stored.
			expect(batchKeys(1)).toEqual(['p2', 'p3']);
		});

		it('waits before retrying, and waits longer each time', async () => {
			// Two failures then success, so there are two gaps to observe.
			wireDelete(['p1'], [unprocessed(['p1']), unprocessed(['p1']), {}]);
			const pending = deleteFestivalReq('newfest26');

			await vi.advanceTimersByTimeAsync(0);
			expect(commandsOfType('BatchWrite')).toHaveLength(1);

			// With jitter pinned to its floor the first backoff is the 50ms base. Stopping a
			// millisecond short proves it is waiting rather than retrying immediately.
			await vi.advanceTimersByTimeAsync(49);
			expect(commandsOfType('BatchWrite')).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(commandsOfType('BatchWrite')).toHaveLength(2);

			// The second gap doubles to 100ms rather than repeating the first.
			await vi.advanceTimersByTimeAsync(99);
			expect(commandsOfType('BatchWrite')).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(1);
			expect(commandsOfType('BatchWrite')).toHaveLength(3);

			await vi.runAllTimersAsync();
			expect(statusOf(await pending)).toBe(200);
		});

		it('gives up after five attempts and reports a server error', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			// Never clears: every attempt hands the same item back.
			wireDelete(['p1'], [unprocessed(['p1'])]);

			const res = await runDelete();

			expect(commandsOfType('BatchWrite')).toHaveLength(5);
			// A stranded row must not read as success — the route reports the failure.
			expect(statusOf(res)).toBe(500);
			consoleError.mockRestore();
		});

		it('stops as soon as a retry clears the backlog', async () => {
			wireDelete(['p1', 'p2'], [unprocessed(['p2']), {}]);

			const res = await runDelete();

			expect(statusOf(res)).toBe(200);
			expect(commandsOfType('BatchWrite')).toHaveLength(2);
		});

		it('splits a delete larger than one batch, and retries each part on its own', async () => {
			// 26 performances: DynamoDB caps a BatchWrite at 25 items across all tables.
			const ids = Array.from({ length: 26 }, (_, i) => `p${i + 1}`);
			wireDelete(ids, [{}]);

			const res = await runDelete();

			expect(statusOf(res)).toBe(200);
			expect(commandsOfType('BatchWrite')).toHaveLength(2);
			expect(batchKeys(0)).toHaveLength(25);
			expect(batchKeys(1)).toEqual(['p26']);
		});
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
			event(
				{
					routeKey: 'POST /api/stagehopper/admin/festivals/{id}/image-upload',
					pathParameters: { id: festivalId },
					body: JSON.stringify(body),
					...overrides
				},
				ADMIN_CLAIMS
			)
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
			event(
				{
					routeKey: 'POST /api/stagehopper/admin/festivals/{id}/map-upload',
					pathParameters: { id: festivalId },
					body: JSON.stringify(body),
					...overrides
				},
				ADMIN_CLAIMS
			)
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
		process.env.PICKS_TABLE = 'stagehopper-picks';
	});

	afterEach(() => {
		delete process.env.PICKS_TABLE;
		delete process.env.SITE_ORIGIN;
		delete process.env.SITE_BUCKET;
		delete process.env.CF_DISTRIBUTION_ID;
		delete process.env.FESTIVALS_TABLE;
		delete process.env.PERFORMANCES_TABLE;
	});

	async function importTimetable(body: unknown, festivalId = 'tmr26') {
		const { handler } = await loadLambda();
		return handler(
			event(
				{
					routeKey: 'POST /api/stagehopper/admin/festivals/{id}/timetable-import',
					pathParameters: { id: festivalId },
					body: JSON.stringify(body)
				},
				ADMIN_CLAIMS
			)
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
		// The other caller of the retry loop. Everything else that exercises it goes through
		// the delete route, so `batchPut` could quietly stop retrying — writing performances
		// with a bare send — and every one of those tests would stay green while an import
		// silently landed half a timetable.
		it('retries performances DynamoDB leaves unprocessed', async () => {
			vi.useFakeTimers();
			const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
			try {
				const stored: Record<string, unknown>[] = [];
				let handedBack = false;
				send.mockImplementation((command: MockCommand) => {
					if (command.__command === 'Query') return Promise.resolve({ Items: stored });
					if (command.__command !== 'BatchWrite') return Promise.resolve({});

					const requests = (command.input.RequestItems?.['stagehopper-performances'] ?? []) as {
						PutRequest: { Item: Record<string, unknown> };
					}[];
					// Accept the batch but hand the first item straight back, once.
					if (!handedBack && requests.length > 1) {
						handedBack = true;
						stored.push(...requests.slice(1).map((r) => r.PutRequest.Item));
						return Promise.resolve({
							UnprocessedItems: { 'stagehopper-performances': [requests[0]] }
						});
					}
					stored.push(...requests.map((r) => r.PutRequest.Item));
					return Promise.resolve({ UnprocessedItems: {} });
				});

				const { handler } = await loadLambda();
				const pending = handler(
					event(
						{
							routeKey: 'POST /api/stagehopper/admin/festivals/{id}/timetable-import',
							pathParameters: { id: 'tmr26' },
							body: JSON.stringify({
								timetable: uploadTimetable({
									days: [
										{
											date: '2026-07-17',
											performances: [
												{ artist: 'A', stage: 'MAIN', startTime: '22:00', endTime: '23:00' },
												{ artist: 'B', stage: 'MAIN', startTime: '23:00', endTime: '23:59' }
											]
										}
									]
								})
							})
						},
						ADMIN_CLAIMS
					)
				);

				let settled = false;
				void pending.then(() => (settled = true));
				for (let i = 0; i < 5 && !settled; i++) await vi.runAllTimersAsync();
				const res = await pending;

				expect(statusOf(res)).toBe(200);
				// Both sets stored: the one handed back was written by the retry, not dropped.
				expect(stored).toHaveLength(2);
				expect(stored.map((item) => item.artist).sort()).toEqual(['A', 'B']);
			} finally {
				vi.useRealTimers();
				randomSpy.mockRestore();
			}
		});

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
			/** `Query` answers the existence check, the id sweep and the Picks gate. */
			function wireExisting({
				performances = [] as Record<string, unknown>[],
				picks = [] as Record<string, unknown>[],
				festival = undefined as Record<string, unknown> | undefined
			} = {}) {
				const written: Record<string, unknown>[] = [];
				send.mockImplementation((command: MockCommand) => {
					if (command.__command === 'Query' && command.input.TableName === 'stagehopper-picks') {
						return Promise.resolve({ Items: picks });
					}
					if (command.__command === 'Query') {
						// After the replace, the republish sweep must see only what was just written.
						return Promise.resolve({ Items: written.length > 0 ? written : performances });
					}
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
			// and notification override is keyed by a performance id. There is no override.
			it('refuses to replace a timetable while the festival has Picks', async () => {
				wireExisting({ performances: EXISTING, picks: [{ festivalId: 'tmr26', userId: 'clerk:1' }] });

				const res = await importTimetable({ timetable: uploadTimetable(), replace: true });

				expect(statusOf(res)).toBe(409);
				expect(bodyOf(res)).toEqual({
					error: 'Festival schedule cannot be re-imported, since there are existing festival picks.'
				});
				const gate = commandsOfType('Query').find((c) => c.input.TableName === 'stagehopper-picks')!;
				expect(gate.input).toMatchObject({ Limit: 1, ConsistentRead: true });
				expect(commandsOfType('BatchWrite')).toHaveLength(0);
				expect(s3Send).not.toHaveBeenCalled();
			});

			it('fails closed when PICKS_TABLE is not configured', async () => {
				const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
				delete process.env.PICKS_TABLE;
				wireExisting({ performances: EXISTING });

				const res = await importTimetable({ timetable: uploadTimetable(), replace: true });

				expect(statusOf(res)).toBe(409);
				expect(commandsOfType('BatchWrite')).toHaveLength(0);
				consoleError.mockRestore();
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
					if (command.__command === 'Query') {
						return Promise.resolve({
							Items: command.input.TableName === 'stagehopper-picks' ? [] : EXISTING
						});
					}
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
			it('does not check for Picks when there is no timetable to replace', async () => {
				wirePerformancesStore();

				const res = await importTimetable({ timetable: uploadTimetable(), replace: true });

				expect(statusOf(res)).toBe(200);
				expect(
					commandsOfType('Query').filter((c) => c.input.TableName === 'stagehopper-picks')
				).toHaveLength(0);
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
					if (command.__command === 'Query' && command.input.TableName === 'stagehopper-picks') {
						return Promise.resolve({ Items: [] });
					}
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
				event(
					{
						routeKey: 'POST /api/stagehopper/admin/festivals/{id}/timetable-import',
						body: JSON.stringify({ timetable: uploadTimetable() })
					},
					ADMIN_CLAIMS
				)
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
			event(
				{
					routeKey: 'PATCH /api/stagehopper/admin/festivals/{id}/timetable',
					pathParameters: { id: festivalId },
					body: JSON.stringify(body),
					...overrides
				},
				ADMIN_CLAIMS
			)
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

describe('admin: browse and delete users (#38)', () => {
	beforeEach(() => {
		vi.resetModules();
		send.mockReset();
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
		process.env.USERS_TABLE = 'stagehopper-users';
		process.env.PUSH_SUBSCRIPTIONS_TABLE = 'stagehopper-push-subscriptions';
		process.env.PICKS_TABLE = 'stagehopper-picks';
		process.env.MESSAGES_TABLE = 'stagehopper-messages';
	});

	afterEach(() => {
		delete process.env.SITE_ORIGIN;
		delete process.env.USERS_TABLE;
		delete process.env.PUSH_SUBSCRIPTIONS_TABLE;
		delete process.env.PICKS_TABLE;
		delete process.env.MESSAGES_TABLE;
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

	const listUsers = async (body: unknown = {}) => {
		const { handler } = await loadLambda();
		return handler(
			event({ routeKey: 'POST /api/stagehopper/admin/users', body: JSON.stringify(body) }, ADMIN_CLAIMS)
		);
	};
	const deleteUser = async (userId: string, body: unknown = {}) => {
		const { handler } = await loadLambda();
		return handler(
			event(
				{
					routeKey: 'DELETE /api/stagehopper/admin/users/{userId}',
					pathParameters: { userId },
					body: JSON.stringify(body)
				},
				ADMIN_CLAIMS
			)
		);
	};

	describe('listing users', () => {
		it('lists one entry per user row', async () => {
			mockDynamo({
				scanItems: [
					{
						userId: 'clerk:1',
						name: 'New',
						email: 'al@example.com',
						lastActive: 200
					},
					{ userId: 'clerk:2', name: 'Bo', email: 'bo@example.com', lastActive: 90 },
					// A user row with nothing but identity on it.
					{ userId: 'clerk:3', name: 'Solo', email: 'solo@example.com', lastActive: 300 },
					{ userId: 'clerk:4', name: 'Bad', email: 'bad@example.com', lastActive: 5, banned: true },
					// Only a literal true bans; anything else is ignored.
					{ userId: 'clerk:5', name: 'Odd', email: 'odd@example.com', lastActive: 6, banned: 'yes' }
				]
			});

			const { users } = bodyOf(await listUsers());

			expect(users).toContainEqual({
				userId: 'clerk:1',
				name: 'New',
				email: 'al@example.com',
				lastActive: 200,
				banned: false
			});
			expect(users).toContainEqual({
				userId: 'clerk:2',
				name: 'Bo',
				email: 'bo@example.com',
				lastActive: 90,
				banned: false
			});
						expect(users).toContainEqual({
				userId: 'clerk:3',
				name: 'Solo',
				email: 'solo@example.com',
				lastActive: 300,
				banned: false
			});
			expect(users.find((u: { userId: string }) => u.userId === 'clerk:4').banned).toBe(true);
			expect(users.find((u: { userId: string }) => u.userId === 'clerk:5').banned).toBe(false);
		});

		it('surfaces the continuation token and honours an incoming start key', async () => {
			mockDynamo({ scanItems: [], scanNextKey: { userId: 'clerk:5' } });

			const res = await listUsers({ startKey: { userId: 'clerk:1' } });

			expect(bodyOf(res).nextKey).toEqual({ userId: 'clerk:5' });
			expect(commandsOfType('Scan')[0]!.input.ExclusiveStartKey).toEqual({ userId: 'clerk:1' });
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

	describe('deleting a user', () => {
		it('removes the user row and their subscriptions', async () => {
			send.mockImplementation((command: MockCommand) => {
								if (command.__command === 'Get') {
					return Promise.resolve({
						Item: { userId: 'clerk:1' }
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
			expect(bodyOf(res)).toEqual({ ok: true });

			const deletes = allDeletes();
			expect(deletes).toContainEqual({ table: 'stagehopper-users', key: { userId: 'clerk:1' } });
			expect(deletes).toContainEqual({ table: 'stagehopper-push-subscriptions', key: { userId: 'clerk:1', endpoint: 'https://push/a' } });
			expect(deletes).toHaveLength(2);
		});

		it('answers 400 for a malformed user id, before any read', async () => {
			mockDynamo();

			expect(statusOf(await deleteUser('not-a-user-id'))).toBe(400);
			expect(send).not.toHaveBeenCalled();
		});

	});

	describe('moderation (#209)', () => {
		const SELF = 'clerk:1234567890';
		let userRows: Record<string, Record<string, unknown>>;
		let pickRows: { festivalId: string; userId: string }[];
		let messageRows: { festivalId: string; messageId: string; userId: string }[];

		const conditionFailure = () =>
			Promise.reject(Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' }));

		/** Answer every command per TableName and IndexName, so no Query leaks into another table's flow. */
		function wire() {
			userRows = {};
			pickRows = [];
			messageRows = [];
			send.mockImplementation((command: MockCommand) => {
				const { TableName, IndexName } = command.input;
				if (command.__command === 'Get' && TableName === 'stagehopper-users') {
					return Promise.resolve({ Item: userRows[command.input.Key.userId] });
				}
				if (command.__command === 'Update' && TableName === 'stagehopper-users') {
					if (!userRows[command.input.Key.userId]) return conditionFailure();
					return Promise.resolve({});
				}
				if (command.__command === 'Query' && TableName === 'stagehopper-picks' && IndexName === 'userId-index') {
					const u = command.input.ExpressionAttributeValues[':u'];
					return Promise.resolve({ Items: pickRows.filter((r) => r.userId === u) });
				}
				if (command.__command === 'Query' && TableName === 'stagehopper-messages' && IndexName === 'userId-index') {
					const u = command.input.ExpressionAttributeValues[':u'];
					return Promise.resolve({
						Items: messageRows
							.filter((r) => r.userId === u)
							.map(({ festivalId, messageId }) => ({ festivalId, messageId }))
					});
				}
				if (command.__command === 'BatchWrite') return Promise.resolve({ UnprocessedItems: {} });
				return Promise.resolve({ Items: [] });
			});
		}
		beforeEach(wire);

		const ban = async (userId: string, method: 'POST' | 'DELETE', claims: Record<string, unknown> = ADMIN_CLAIMS) => {
			const { handler } = await loadLambda();
			return handler(
				event(
					{ routeKey: `${method} /api/stagehopper/admin/users/{userId}/ban`, pathParameters: { userId } },
					claims
				)
			);
		};

		describe('ban and unban', () => {
			it('bans a known user: SET banned, guarded so no row is created', async () => {
				userRows['clerk:7'] = { userId: 'clerk:7' };

				const res = await ban('clerk:7', 'POST');

				expect(statusOf(res)).toBe(200);
				expect(bodyOf(res)).toEqual({ ok: true, userId: 'clerk:7', banned: true });
				const update = commandsOfType('Update')[0]!.input;
				expect(update.TableName).toBe('stagehopper-users');
				expect(update.Key).toEqual({ userId: 'clerk:7' });
				expect(update.UpdateExpression).toBe('SET banned = :t');
				expect(update.ConditionExpression).toBe('attribute_exists(userId)');
				expect(update.ExpressionAttributeValues).toEqual({ ':t': true });
			});

			it('unbans: REMOVE banned, same guard', async () => {
				userRows['clerk:7'] = { userId: 'clerk:7', banned: true };

				const res = await ban('clerk:7', 'DELETE');

				expect(statusOf(res)).toBe(200);
				expect(bodyOf(res)).toEqual({ ok: true, userId: 'clerk:7', banned: false });
				const update = commandsOfType('Update')[0]!.input;
				expect(update.UpdateExpression).toBe('REMOVE banned');
				expect(update.ConditionExpression).toBe('attribute_exists(userId)');
			});

			it('answers 404 for an unknown user, both ways', async () => {
				for (const method of ['POST', 'DELETE'] as const) {
					const res = await ban('clerk:nobody', method);
					expect(statusOf(res)).toBe(404);
					expect(bodyOf(res)).toEqual({ error: 'User not found' });
				}
			});

			it('answers 403 to a non-admin, before any write', async () => {
				userRows['clerk:7'] = { userId: 'clerk:7' };

				expect(statusOf(await ban('clerk:7', 'POST', USER_CLAIMS))).toBe(403);
				expect(statusOf(await ban('clerk:7', 'DELETE', USER_CLAIMS))).toBe(403);
				expect(commandsOfType('Update')).toHaveLength(0);
			});

			it('answers 400 for a malformed user id, before any write', async () => {
				expect(statusOf(await ban('not-a-user-id', 'POST'))).toBe(400);
				expect(statusOf(await ban('not-a-user-id', 'DELETE'))).toBe(400);
				expect(send).not.toHaveBeenCalled();
			});

			it('refuses to ban yourself, but lets you unban yourself', async () => {
				userRows[SELF] = { userId: SELF, banned: true };

				const banSelf = await ban(SELF, 'POST');
				expect(statusOf(banSelf)).toBe(400);
				expect(bodyOf(banSelf)).toEqual({ error: 'You cannot ban yourself' });
				expect(commandsOfType('Update')).toHaveLength(0);

				expect(statusOf(await ban(SELF, 'DELETE'))).toBe(200);
			});
		});

		describe('deleting a user also removes their Picks and Messages', () => {
			it('puts every Picks row and every Message of the user, across Festivals, in the batch', async () => {
				userRows['clerk:1'] = { userId: 'clerk:1' };
				pickRows = [
					{ festivalId: 'tmr26', userId: 'clerk:1' },
					{ festivalId: 'ps26', userId: 'clerk:1' },
					{ festivalId: 'tmr26', userId: 'clerk:2' }
				];
				messageRows = [
					{ festivalId: 'tmr26', messageId: '0000000000001-aaaaaaaa', userId: 'clerk:1' },
					{ festivalId: 'ps26', messageId: '0000000000002-bbbbbbbb', userId: 'clerk:1' },
					{ festivalId: 'tmr26', messageId: '0000000000003-cccccccc', userId: 'clerk:2' }
				];

				const res = await deleteUser('clerk:1');

				expect(statusOf(res)).toBe(200);
				const deletes = allDeletes();
				const of = (table: string) => deletes.filter((d) => d.table === table).map((d) => d.key);
				expect(of('stagehopper-picks')).toHaveLength(2);
				expect(of('stagehopper-picks')).toContainEqual({ festivalId: 'tmr26', userId: 'clerk:1' });
				expect(of('stagehopper-picks')).toContainEqual({ festivalId: 'ps26', userId: 'clerk:1' });
				expect(of('stagehopper-messages')).toHaveLength(2);
				expect(of('stagehopper-messages')).toContainEqual({ festivalId: 'tmr26', messageId: '0000000000001-aaaaaaaa' });
				expect(of('stagehopper-messages')).toContainEqual({ festivalId: 'ps26', messageId: '0000000000002-bbbbbbbb' });
				// An unbanned user's row goes entirely, and no tombstone is written.
				expect(of('stagehopper-users')).toEqual([{ userId: 'clerk:1' }]);
				expect(commandsOfType('Put')).toHaveLength(0);
			});

			it('keeps a tombstone for a Banned user: row replaced by { userId, banned }, not deleted', async () => {
				userRows['clerk:1'] = {
					userId: 'clerk:1',
					banned: true,
					name: 'Bad',
					email: 'b@example.com',
					colour: '#e74c3c'
				};
				pickRows = [{ festivalId: 'tmr26', userId: 'clerk:1' }];
				messageRows = [{ festivalId: 'tmr26', messageId: '0000000000001-aaaaaaaa', userId: 'clerk:1' }];

				const res = await deleteUser('clerk:1');

				expect(statusOf(res)).toBe(200);
				const deletes = allDeletes();
				expect(deletes.filter((d) => d.table === 'stagehopper-users')).toHaveLength(0);
				expect(deletes.filter((d) => d.table === 'stagehopper-picks')).toHaveLength(1);
				expect(deletes.filter((d) => d.table === 'stagehopper-messages')).toHaveLength(1);
				const puts = commandsOfType('Put');
				expect(puts).toHaveLength(1);
				expect(puts[0]!.input).toEqual({ TableName: 'stagehopper-users', Item: { userId: 'clerk:1', banned: true } });
			});

			it('writes the tombstone only after the batch delete', async () => {
				userRows['clerk:1'] = { userId: 'clerk:1', banned: true };

				await deleteUser('clerk:1');

				const order = send.mock.calls.map(([c]) => (c as MockCommand).__command);
				expect(order.lastIndexOf('BatchWrite')).toBeLessThan(order.indexOf('Put'));
			});
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
				event(
					{
						routeKey: 'POST /api/stagehopper/admin/users/{userId}/test-notification',
						pathParameters: { userId },
						body: JSON.stringify(body)
					},
					ADMIN_CLAIMS
				)
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

describe('Festival Picks and Attendee profile (#204)', () => {
	const USER = { ...USER_CLAIMS, username: 'alex_h' };
	const OTHER = { sub: '999', name: 'Sam', email: 'sam@example.com', scope: 'user', username: 'sam' };
	const RED = '#e74c3c';
	const BLUE = '#3498db';

	let users: Record<string, Record<string, any>>;
	let picks: Record<string, Record<string, any>>;
	let festivals: Record<string, Record<string, any>>;

	const pickKey = (festivalId: string, userId: string) => `${festivalId}|${userId}`;

	/** An in-memory stand-in for the three tables, keyed the way the real ones are. */
	function wireTables() {
		users = {};
		picks = {};
		// Festival rows the Picks save checks for existence (#216); one Unlisted, since listing is irrelevant to it.
		festivals = {
			tmr26: { id: "tmr26" },
			ps26: { id: "ps26" },
			hidden26: { id: "hidden26", isListedOnLanding: false }
		};
		send.mockImplementation((command: MockCommand) => {
			const input = command.input;
			if (command.__command === 'Update' && input.TableName === 'stagehopper-users') {
				const userId = input.Key.userId as string;
				const old = users[userId];
				if (input.ConditionExpression === 'attribute_exists(colour)' && !old?.colour) {
					return Promise.reject(
						Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' })
					);
				}
				const v = input.ExpressionAttributeValues;
				// Evaluates the handle part of the expression: `handle = :h`, `handle = :seed` and
				// `if_not_exists(handle, :seed)` differ, so a change to the expression shows in the specs.
				const expr = String(input.UpdateExpression);
				users[userId] = {
					...old,
					userId,
					name: v[':n'],
					email: v[':e'],
					...(expr.includes('handle = :h') && { handle: v[':h'] }),
					...(expr.includes('handle = :seed') && { handle: v[':seed'] }),
					...(expr.includes('handle = if_not_exists(handle, :seed)') &&
						old?.handle === undefined && { handle: v[':seed'] }),
					...(v[':c'] !== undefined && { colour: v[':c'] })
				};
				return Promise.resolve({
					Attributes: input.ReturnValues === 'ALL_NEW' ? users[userId] : old
				});
			}
			if (command.__command === 'Get' && input.TableName === 'stagehopper-users') {
				return Promise.resolve({ Item: users[input.Key.userId] });
			}
			if (command.__command === 'Get' && input.TableName === 'stagehopper-festivals') {
				return Promise.resolve({ Item: festivals[input.Key.id] });
			}
			if (command.__command === 'Get' && input.TableName === 'stagehopper-picks') {
				return Promise.resolve({
					Item: picks[pickKey(input.Key.festivalId, input.Key.userId)]
				});
			}
			if (command.__command === 'Put' && input.TableName === 'stagehopper-picks') {
				picks[pickKey(input.Item.festivalId, input.Item.userId)] = input.Item;
				return Promise.resolve({});
			}
			if (command.__command === 'Delete' && input.TableName === 'stagehopper-picks') {
				delete picks[pickKey(input.Key.festivalId, input.Key.userId)];
				return Promise.resolve({});
			}
			if (command.__command === 'Update' && input.TableName === 'stagehopper-picks') {
				const row = picks[pickKey(input.Key.festivalId, input.Key.userId)];
				if (!row) {
					return Promise.reject(
						Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' })
					);
				}
				row.handle = input.ExpressionAttributeValues[':h'];
				row.colour = input.ExpressionAttributeValues[':c'];
				return Promise.resolve({});
			}
			if (command.__command === 'Query' && input.TableName === 'stagehopper-picks') {
				const rows = Object.values(picks);
				if (input.IndexName === 'userId-index') {
					const u = input.ExpressionAttributeValues[':u'];
					return Promise.resolve({
						Items: rows.filter((r) => r.userId === u).map((r) => ({
							festivalId: r.festivalId,
							userId: r.userId
						}))
					});
				}
				const f = input.ExpressionAttributeValues[':fid'] ?? input.ExpressionAttributeValues[':v'];
				const items = rows.filter((r) => r.festivalId === f);
				return Promise.resolve({ Items: input.Limit ? items.slice(0, input.Limit) : items });
			}
			if (command.__command === 'BatchWrite') {
				for (const req of input.RequestItems['stagehopper-picks'] ?? []) {
					const k = req.DeleteRequest.Key;
					delete picks[pickKey(k.festivalId, k.userId)];
				}
				return Promise.resolve({ UnprocessedItems: {} });
			}
			return Promise.resolve({ Items: [] });
		});
	}

	beforeEach(() => {
		vi.resetModules();
		send.mockReset();
		s3Send.mockReset().mockResolvedValue({});
		cloudfrontSend.mockReset().mockResolvedValue({});
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
		process.env.USERS_TABLE = 'stagehopper-users';
		process.env.PICKS_TABLE = 'stagehopper-picks';
		process.env.FESTIVALS_TABLE = 'stagehopper-festivals';
		process.env.PERFORMANCES_TABLE = 'stagehopper-performances';
		wireTables();
	});

	afterEach(() => {
		delete process.env.SITE_ORIGIN;
		delete process.env.USERS_TABLE;
		delete process.env.PICKS_TABLE;
		delete process.env.FESTIVALS_TABLE;
		delete process.env.PERFORMANCES_TABLE;
	});

	async function call(
		routeKey: string,
		{
			body,
			claims = USER,
			id = 'tmr26'
		}: { body?: unknown; claims?: Record<string, unknown> | null; id?: string } = {}
	) {
		const { handler } = await loadLambda();
		return handler(
			event(
				{
					routeKey,
					pathParameters: { id },
					...(body !== undefined && { body: JSON.stringify(body) })
				},
				claims
			)
		);
	}
	const getPicks = (o?: Parameters<typeof call>[1]) =>
		call('GET /api/stagehopper/festivals/{id}/picks', { claims: null, ...o });
	const getMine = (o?: Parameters<typeof call>[1]) =>
		call('GET /api/stagehopper/festivals/{id}/picks/me', o);
	const putPicks = (body: unknown, o?: Parameters<typeof call>[1]) =>
		call('PUT /api/stagehopper/festivals/{id}/picks', { body, ...o });
	const getProfile = (o?: Parameters<typeof call>[1]) =>
		call('GET /api/stagehopper/users/me/profile', o);
	const putProfile = (body: unknown, o?: Parameters<typeof call>[1]) =>
		call('PUT /api/stagehopper/users/me/profile', { body, ...o });

	describe('profile', () => {
		it('returns the seed and a null colour for a user with no row, without writing', async () => {
			const res = await getProfile();

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({ nickname: 'alex_h', handle: 'alex_h', colour: null });
			expect(commandsOfType('Update')).toHaveLength(0);
			expect(commandsOfType('Put')).toHaveLength(0);
		});

		it('returns an empty Nickname for no username claim or an invalid seed', async () => {
			for (const claims of [
				USER_CLAIMS,
				{ ...USER_CLAIMS, username: 'x' },
				{ ...USER_CLAIMS, username: 'a'.repeat(21) },
				{ ...USER_CLAIMS, username: 'bad name!' }
			]) {
				expect(bodyOf(await getProfile({ claims }))).toEqual({
					nickname: '',
					handle: '',
					colour: null
				});
			}
		});

		it('returns the stored Nickname over the seed', async () => {
			await putProfile({ nickname: 'Stored-1' });

			expect(bodyOf(await getProfile())).toEqual({
				nickname: 'Stored-1',
				handle: 'Stored-1',
				colour: null
			});
		});

		it('stores a palette colour and returns it next time, seeding the Nickname once', async () => {
			const put = await putProfile({ colour: RED, handle: 'someone_else' });

			expect(statusOf(put)).toBe(200);
			expect(bodyOf(put)).toEqual({ nickname: 'alex_h', handle: 'alex_h', colour: RED });
			expect(bodyOf(await getProfile({ claims: { ...USER, username: 'changed' } }))).toEqual({
				nickname: 'alex_h',
				handle: 'alex_h',
				colour: RED
			});
			expect(users['clerk:1234567890']!.handle).toBe('alex_h');
		});

		it('renames: trims, stores, and rewrites the Picks copies', async () => {
			await putProfile({ colour: RED });
			await putPicks({ selections: { p1: 2 } });

			const put = await putProfile({ nickname: '  New_Name ' });

			expect(bodyOf(put)).toEqual({ nickname: 'New_Name', handle: 'New_Name', colour: RED });
			expect(
				send.mock.calls.filter(([c]) => c.input.TableName === 'stagehopper-messages')
			).toHaveLength(0);
			expect(users['clerk:1234567890']!.handle).toBe('New_Name');
			expect(picks['tmr26|clerk:1234567890']!.handle).toBe('New_Name');
		});

		it.each(['', 'x', 'a'.repeat(21), 'has space', 'émile', 5, null])(
			'rejects the Nickname %j and writes nothing',
			async (nickname) => {
				const res = await putProfile({ nickname, colour: RED });

				expect(statusOf(res)).toBe(400);
				expect(bodyOf(res).error).toMatch(/nickname/);
				expect(commandsOfType('Update')).toHaveLength(0);
			}
		);

		it('rejects {} and a bad colour next to a good Nickname, writing nothing', async () => {
			expect(statusOf(await putProfile({}))).toBe(400);
			expect(statusOf(await putProfile({ nickname: 'good_one', colour: '#123456' }))).toBe(400);
			expect(commandsOfType('Update')).toHaveLength(0);
		});

		it('lets two users share a Nickname', async () => {
			expect(statusOf(await putProfile({ nickname: 'twin' }))).toBe(200);
			expect(statusOf(await putProfile({ nickname: 'twin' }, { claims: OTHER }))).toBe(200);
		});

		it('keeps a rename through a colour-only update, a Pick save and a resolve', async () => {
			await putProfile({ colour: RED });
			await putPicks({ selections: { p1: 2 } });
			await putProfile({ nickname: 'renamed' });

			await putProfile({ colour: BLUE });
			expect(users['clerk:1234567890']!.handle).toBe('renamed');
			expect(picks['tmr26|clerk:1234567890']!.handle).toBe('renamed');

			await putPicks({ selections: { p1: 1 } });
			expect(users['clerk:1234567890']!.handle).toBe('renamed');
			expect(picks['tmr26|clerk:1234567890']!.handle).toBe('renamed');

			send.mockClear();
			await putPicks({ selections: { p1: 2 } });
			expect(
				commandsOfType('Update').filter((c) => c.input.TableName === 'stagehopper-picks')
			).toHaveLength(0);
			expect(picks['tmr26|clerk:1234567890']!.handle).toBe('renamed');
		});

		it('stores the canonical lowercase value of an upper-case palette colour', async () => {
			await putProfile({ colour: RED.toUpperCase() });

			expect(users['clerk:1234567890']!.colour).toBe(RED);
		});

		it('rejects a colour outside the palette and leaves the stored one alone', async () => {
			await putProfile({ colour: RED });
			send.mockClear();

			const res = await putProfile({ colour: '#123456' });

			expect(statusOf(res)).toBe(400);
			expect(commandsOfType('Update')).toHaveLength(0);
			expect(users['clerk:1234567890']!.colour).toBe(RED);
		});

		it('sets a colour for a caller whose token carries no username', async () => {
			const res = await putProfile({ colour: RED }, { claims: USER_CLAIMS });

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({ nickname: '', handle: '', colour: RED });
		});

		it('sets the first Nickname for a caller whose token carries no username', async () => {
			const res = await putProfile({ nickname: 'first_one' }, { claims: USER_CLAIMS });

			expect(bodyOf(res)).toEqual({ nickname: 'first_one', handle: 'first_one', colour: null });
		});

		it('answers 401 without claims', async () => {
			expect(statusOf(await putProfile({ colour: RED }, { claims: null }))).toBe(401);
		});
	});

	describe('PUT picks', () => {
		beforeEach(async () => {
			await putProfile({ colour: RED });
			send.mockClear();
		});

		it('answers 401 without claims, after the id check', async () => {
			expect(statusOf(await putPicks({ selections: { p1: 2 } }, { claims: null }))).toBe(401);
			expect(statusOf(await putPicks({ selections: {} }, { id: 'Bad Id!' }))).toBe(400);
			expect(commandsOfType('Put')).toHaveLength(0);
		});

		it('saves the map under the caller, with their handle and colour', async () => {
			const res = await putPicks({ selections: { p1: 2, p2: 1 } });

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({ ok: true });
			expect(picks['tmr26|clerk:1234567890']).toMatchObject({
				festivalId: 'tmr26',
				userId: 'clerk:1234567890',
				handle: 'alex_h',
				colour: RED,
				selections: { p1: 2, p2: 1 }
			});
		});

		it('ignores body keys other than selections (name, color, festivalId)', async () => {
			const res = await putPicks({
				name: 'Alex',
				color: BLUE,
				festivalId: 'other26',
				selections: { p1: 1 }
			});

			expect(statusOf(res)).toBe(200);
			const item = picks['tmr26|clerk:1234567890']!;
			expect(item.colour).toBe(RED);
			expect(item.festivalId).toBe('tmr26');
			expect(item).not.toHaveProperty('name');
			expect(item).not.toHaveProperty('color');
			expect(bodyOf(await getMine())).toEqual({ selections: { p1: 1 } });
		});

		it('drops 0 states', async () => {
			await putPicks({ selections: { p1: 2, p2: 0 } });

			expect(picks['tmr26|clerk:1234567890']!.selections).toEqual({ p1: 2 });
		});

		it('deletes the row when nothing is left, so it neither blocks re-import nor counts', async () => {
			await putPicks({ selections: { p1: 2 } });

			const res = await putPicks({ selections: { p1: 0 } });

			expect(statusOf(res)).toBe(200);
			expect(picks['tmr26|clerk:1234567890']).toBeUndefined();
		});

		it('refuses with "choose a colour first" and writes nothing for a user without a colour', async () => {
			const res = await putPicks({ selections: { p1: 2 } }, { claims: OTHER });

			expect(statusOf(res)).toBe(400);
			expect(bodyOf(res).error).toBe('choose a colour first');
			expect(commandsOfType('Put')).toHaveLength(0);
			expect(users['clerk:999']?.colour).toBeUndefined();
		});

		describe('as a Banned user (#209)', () => {
			it('answers 403, not the Nickname error, for a banned user with no Nickname', async () => {
				const claims = { ...USER_CLAIMS, sub: '8' };
				await putProfile({ colour: RED }, { claims });
				users['clerk:8']!.banned = true;
				send.mockClear();

				const res = await putPicks({ selections: { p1: 2 } }, { claims });

				expect(statusOf(res)).toBe(403);
				expect(bodyOf(res).error).toBe('You are banned');
				expect(commandsOfType('Put')).toHaveLength(0);
			});

			it('answers 403 and writes no Picks, whatever the map holds', async () => {
				await putPicks({ selections: { p1: 2 } });
				users['clerk:1234567890']!.banned = true;
				send.mockClear();

				for (const selections of [{ p1: 1 }, {}]) {
					const res = await putPicks({ selections });
					expect(statusOf(res)).toBe(403);
					expect(bodyOf(res).error).toBe('You are banned');
				}
				expect(commandsOfType('Put')).toHaveLength(0);
				expect(commandsOfType('Delete')).toHaveLength(0);
				expect(picks['tmr26|clerk:1234567890']!.selections).toEqual({ p1: 2 });
			});

			it('answers 403, not 400, when the banned user has no colour', async () => {
				users['clerk:999'] = { userId: 'clerk:999', banned: true };

				const res = await putPicks({ selections: { p1: 2 } }, { claims: OTHER });

				expect(statusOf(res)).toBe(403);
				expect(commandsOfType('Put')).toHaveLength(0);
			});

			it('still reads: picks/me answers 200', async () => {
				users['clerk:1234567890']!.banned = true;

				expect(statusOf(await getMine())).toBe(200);
			});

			it('saves again once unbanned', async () => {
				users['clerk:1234567890']!.banned = true;
				expect(statusOf(await putPicks({ selections: { p1: 2 } }))).toBe(403);
				delete users['clerk:1234567890']!.banned;

				expect(statusOf(await putPicks({ selections: { p1: 2 } }))).toBe(200);
				expect(picks['tmr26|clerk:1234567890']!.selections).toEqual({ p1: 2 });
			});
		});

		it('refuses a user with no Nickname and no valid seed, and checks the colour after it', async () => {
			await putProfile({ colour: RED }, { claims: { ...USER_CLAIMS, sub: '7' } });
			send.mockClear();

			const res = await putPicks({ selections: { p1: 2 } }, { claims: { ...USER_CLAIMS, sub: '7' } });

			expect(statusOf(res)).toBe(400);
			expect(bodyOf(res).error).toBe('nickname is required');
			expect(commandsOfType('Put')).toHaveLength(0);

			const noColour = await putPicks({ selections: { p1: 2 } }, { claims: { ...USER, sub: '5' } });
			expect(bodyOf(noColour).error).toBe('choose a colour first');
		});

		describe('unknown Festival (#216)', () => {
			const GHOST = { id: 'ghost26' };
			const festivalReads = () =>
				commandsOfType('Get').filter((c) => c.input.TableName === 'stagehopper-festivals');

			it('refuses 400 and touches no table but the Festival read', async () => {
				const res = await putPicks({ selections: { p1: 2 } }, GHOST);

				expect(statusOf(res)).toBe(400);
				expect(bodyOf(res)).toEqual({ error: 'Unknown festival' });
				expect(picks).toEqual({});
				expect(commandsOfType('Put')).toHaveLength(0);
				expect(commandsOfType('Delete')).toHaveLength(0);
				expect(commandsOfType('Update')).toHaveLength(0);
				expect(festivalReads()).toHaveLength(1);
			});

			it('leaves an orphan row in place when the map is empty', async () => {
				picks['ghost26|clerk:1234567890'] = {
					festivalId: 'ghost26',
					userId: 'clerk:1234567890',
					selections: { p1: 2 }
				};

				const res = await putPicks({ selections: {} }, GHOST);

				expect(statusOf(res)).toBe(400);
				expect(bodyOf(res).error).toBe('Unknown festival');
				expect(commandsOfType('Delete')).toHaveLength(0);
				expect(picks['ghost26|clerk:1234567890']).toBeDefined();
			});

			it('tells a Banned user Unknown festival, not 403', async () => {
				users['clerk:1234567890']!.banned = true;
				send.mockClear();

				const res = await putPicks({ selections: { p1: 2 } }, GHOST);

				expect(statusOf(res)).toBe(400);
				expect(bodyOf(res).error).toBe('Unknown festival');
			});

			it('answers the selections error first, with no Festival read', async () => {
				const res = await putPicks({ selections: { p1: 3 } }, GHOST);

				expect(statusOf(res)).toBe(400);
				expect(bodyOf(res).error).not.toBe('Unknown festival');
				expect(festivalReads()).toHaveLength(0);
			});

			it('does not reach the users table', async () => {
				await putPicks({ selections: { p1: 2 } }, GHOST);

				expect(
					send.mock.calls.filter(([c]) => c.input.TableName === 'stagehopper-users')
				).toHaveLength(0);
			});

			it('still saves and clears Picks for an Unlisted Festival', async () => {
				expect(statusOf(await putPicks({ selections: { p1: 2 } }, { id: 'hidden26' }))).toBe(200);
				expect(picks['hidden26|clerk:1234567890']!.selections).toEqual({ p1: 2 });

				expect(statusOf(await putPicks({ selections: {} }, { id: 'hidden26' }))).toBe(200);
				expect(picks['hidden26|clerk:1234567890']).toBeUndefined();
			});
		});

		it('rejects malformed selections', async () => {
			expect(statusOf(await putPicks({ selections: { p1: 3 } }))).toBe(400);
			expect(statusOf(await putPicks({ selections: [] }))).toBe(400);
			expect(statusOf(await putPicks({}))).toBe(400);
			expect(commandsOfType('Put')).toHaveLength(0);
		});
	});

	describe('GET picks', () => {
		it('answers JSON {} for a Festival nobody picked in, with no claims', async () => {
			const res = await getPicks();

			expect(statusOf(res)).toBe(200);
			expect(bodyOf(res)).toEqual({});
		});

		it('lists each Performance with who picked it, in their colour and state', async () => {
			await putProfile({ colour: RED });
			await putProfile({ colour: BLUE }, { claims: OTHER });
			await putPicks({ selections: { p1: 2, p2: 1 } });
			await putPicks({ selections: { p1: 1 } }, { claims: OTHER });

			const body = bodyOf(await getPicks());

			expect(body.p1).toHaveLength(2);
			expect(body.p1).toContainEqual({
				userId: 'clerk:1234567890',
				nickname: 'alex_h',
				handle: 'alex_h',
				colour: RED,
				state: 2
			});
			expect(body.p1).toContainEqual({ userId: 'clerk:999', nickname: 'sam', handle: 'sam', colour: BLUE, state: 1 });
			expect(body.p2).toEqual([
				{ userId: 'clerk:1234567890', nickname: 'alex_h', handle: 'alex_h', colour: RED, state: 1 }
			]);
		});

		it('never lists an unmarked state', async () => {
			picks['tmr26|clerk:1'] = {
				festivalId: 'tmr26',
				userId: 'clerk:1',
				handle: 'a',
				colour: RED,
				selections: { p1: 0, p2: 2 }
			};

			const res = await getPicks();

			expect(bodyOf(res)).toEqual({
				p2: [{ userId: 'clerk:1', nickname: 'a', handle: 'a', colour: RED, state: 2 }]
			});
		});

		it('rejects a malformed festival id', async () => {
			expect(statusOf(await getPicks({ id: 'Bad Id!' }))).toBe(400);
		});
	});

	describe('GET picks/me', () => {
		it('returns the caller own map, or an empty one', async () => {
			expect(bodyOf(await getMine())).toEqual({ selections: {} });

			await putProfile({ colour: RED });
			await putPicks({ selections: { p1: 2 } });

			expect(bodyOf(await getMine())).toEqual({ selections: { p1: 2 } });
		});

		it('answers 401 without claims', async () => {
			expect(statusOf(await getMine({ claims: null }))).toBe(401);
		});
	});

	describe('keeping Picks rows in step with the user row', () => {
		beforeEach(async () => {
			await putProfile({ colour: RED });
			await putPicks({ selections: { p1: 2 } });
			await putPicks({ selections: { p1: 1 } }, { id: 'ps26' });
		});

		it('rewrites every Picks row, via the GSI, when the colour changes', async () => {
			await putProfile({ colour: BLUE });

			expect(picks['tmr26|clerk:1234567890']!.colour).toBe(BLUE);
			expect(picks['ps26|clerk:1234567890']!.colour).toBe(BLUE);
			const gsi = commandsOfType('Query').find((c) => c.input.IndexName === 'userId-index')!;
			expect(gsi.input.TableName).toBe('stagehopper-picks');
		});

		it('does not rewrite Picks rows when only the token username changes', async () => {
			await putPicks({ selections: { p1: 2 } }, { claims: { ...USER, username: 'alex_new' } });

			expect(picks['ps26|clerk:1234567890']!.handle).toBe('alex_h');
		});

		it('does not touch Picks rows when nothing changed', async () => {
			send.mockClear();

			await putPicks({ selections: { p1: 2 } });

			expect(commandsOfType('Query')).toHaveLength(0);
		});

		it('survives a failing refresh: the save still succeeds', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const base = send.getMockImplementation()!;
			send.mockImplementation((command: MockCommand) =>
				command.__command === 'Update' && command.input.TableName === 'stagehopper-picks'
					? Promise.reject(new Error('throttled'))
					: base(command)
			);

			const res = await putProfile({ colour: BLUE });

			expect(statusOf(res)).toBe(200);
			expect(users['clerk:1234567890']!.colour).toBe(BLUE);
			consoleError.mockRestore();
		});
	});

	describe('deleting', () => {
		it('admin user delete removes the user Picks rows', async () => {
			await putProfile({ colour: RED });
			await putPicks({ selections: { p1: 2 } });
			await putPicks({ selections: { p1: 2 } }, { id: 'ps26' });
			users['clerk:1234567890'] = { userId: 'clerk:1234567890' };
			const { handler } = await loadLambda();

			const res = await handler(
				event(
					{
						routeKey: 'DELETE /api/stagehopper/admin/users/{userId}',
						pathParameters: { userId: 'clerk:1234567890' }
					},
					ADMIN_CLAIMS
				)
			);

			expect(statusOf(res)).toBe(200);
			expect(Object.keys(picks)).toEqual([]);
		});

		it('festival delete removes the Festival Picks rows, not other Festivals', async () => {
			await putProfile({ colour: RED });
			await putPicks({ selections: { p1: 2 } });
			await putPicks({ selections: { p1: 2 } }, { id: 'ps26' });
			const { handler } = await loadLambda();

			const res = await handler(
				event(
					{
						routeKey: 'DELETE /api/stagehopper/admin/festivals/{id}',
						pathParameters: { id: 'tmr26' }
					},
					ADMIN_CLAIMS
				)
			);

			expect(statusOf(res)).toBe(200);
			expect(Object.keys(picks)).toEqual(['ps26|clerk:1234567890']);
		});
	});
});

describe('Room API removed (#211)', () => {
	beforeEach(() => {
		vi.resetModules();
		send.mockReset();
		send.mockResolvedValue({});
		// Still set, as in prod until infra apply 1: the code must ignore them.
		process.env.TABLE_NAME = 'stagehopper-selections';
		process.env.ROOMS_TABLE = 'stagehopper-rooms';
		process.env.SITE_ORIGIN = 'https://stagehopper.example';
		process.env.USERS_TABLE = 'stagehopper-users';
		process.env.PUSH_SUBSCRIPTIONS_TABLE = 'stagehopper-push-subscriptions';
		process.env.PICKS_TABLE = 'stagehopper-picks';
		process.env.MESSAGES_TABLE = 'stagehopper-messages';
	});

	afterEach(() => {
		delete process.env.TABLE_NAME;
		delete process.env.ROOMS_TABLE;
		delete process.env.SITE_ORIGIN;
		delete process.env.USERS_TABLE;
		delete process.env.PUSH_SUBSCRIPTIONS_TABLE;
		delete process.env.PICKS_TABLE;
		delete process.env.MESSAGES_TABLE;
	});

	it.each([
		['POST /api/stagehopper/rooms', USER_CLAIMS],
		['GET /api/stagehopper/rooms/{roomId}/selections', USER_CLAIMS],
		['PUT /api/stagehopper/rooms/{roomId}/selections', USER_CLAIMS],
		['DELETE /api/stagehopper/rooms/{roomId}/selections', USER_CLAIMS],
		['GET /api/stagehopper/users/me/rooms', USER_CLAIMS],
		['POST /api/stagehopper/admin/rooms', ADMIN_CLAIMS],
		['DELETE /api/stagehopper/admin/rooms/{roomId}', ADMIN_CLAIMS]
	])('%s answers the default 404 and touches no table', async (routeKey, claims) => {
		const { handler } = await loadLambda();

		const res = await handler(
			event({ routeKey, pathParameters: { roomId: 'tmr26-abc123' }, body: '{}' }, claims)
		);

		expect(statusOf(res)).toBe(404);
		expect(send).not.toHaveBeenCalled();
	});

	it('lists users without a roomCount, even when a stale rooms map is still on the row', async () => {
		send.mockResolvedValue({
			Items: [{ userId: 'clerk:1', name: 'Al', email: 'a@x.io', lastActive: 5, rooms: { r: {} } }]
		});
		const { handler } = await loadLambda();

		const res = await handler(
			event({ routeKey: 'POST /api/stagehopper/admin/users', body: '{}' }, ADMIN_CLAIMS)
		);

		expect(bodyOf(res).users).toEqual([
			{ userId: 'clerk:1', name: 'Al', email: 'a@x.io', lastActive: 5, banned: false }
		]);
	});

	it('deletes a user without reading or deleting any Room row', async () => {
		send.mockImplementation((command: MockCommand) =>
			Promise.resolve(
				command.__command === 'Get'
					? { Item: { userId: 'clerk:1', rooms: { 'tmr26-aaa111': {} } } }
					: command.__command === 'Query'
						? { Items: [] }
						: {}
			)
		);
		const { handler } = await loadLambda();

		const res = await handler(
			event(
				{
					routeKey: 'DELETE /api/stagehopper/admin/users/{userId}',
					pathParameters: { userId: 'clerk:1' }
				},
				ADMIN_CLAIMS
			)
		);

		expect(statusOf(res)).toBe(200);
		expect(bodyOf(res)).toEqual({ ok: true });
		const tables = send.mock.calls.flatMap(([c]) => {
			const input = (c as MockCommand).input;
			return [input.TableName, ...Object.keys(input.RequestItems ?? {})];
		});
		expect(tables).not.toContain('stagehopper-selections');
		expect(tables).not.toContain('stagehopper-rooms');
	});
});
