import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifyIdToken = vi.fn();
const send = vi.fn();

vi.mock('google-auth-library', () => ({
	OAuth2Client: vi.fn().mockImplementation(() => ({ verifyIdToken }))
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
	DynamoDBClient: vi.fn()
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
	DynamoDBDocumentClient: { from: () => ({ send }) },
	QueryCommand: vi.fn().mockImplementation((input) => ({ __command: 'Query', input })),
	TransactWriteCommand: vi.fn().mockImplementation((input) => ({ __command: 'TransactWrite', input }))
}));

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
		const { resolveGoogleIdentity } = await import('./index.mjs');

		expect(await resolveGoogleIdentity('valid-token')).toEqual({
			ok: true,
			participantKey: 'google:1234567890',
			name: 'Alex Example'
		});
	});

	it('prefers the client-supplied display name over the google profile name', async () => {
		verifyIdToken.mockResolvedValue({
			getPayload: () => ({ sub: '1234567890', name: 'Alex Example' })
		});
		const { resolveGoogleIdentity } = await import('./index.mjs');

		expect(await resolveGoogleIdentity('valid-token', 'Max')).toEqual({
			ok: true,
			participantKey: 'google:1234567890',
			name: 'Max'
		});
	});

	it('falls back to the google profile name when no client name is given', async () => {
		verifyIdToken.mockResolvedValue({
			getPayload: () => ({ sub: '1234567890', name: 'Alex Example' })
		});
		const { resolveGoogleIdentity } = await import('./index.mjs');

		expect(await resolveGoogleIdentity('valid-token', '')).toEqual({
			ok: true,
			participantKey: 'google:1234567890',
			name: 'Alex Example'
		});
	});

	it('rejects a token with no name on the payload and no client name given', async () => {
		verifyIdToken.mockResolvedValue({
			getPayload: () => ({ sub: '1234567890', name: '' })
		});
		const { resolveGoogleIdentity } = await import('./index.mjs');

		expect(await resolveGoogleIdentity('valid-token')).toEqual({
			ok: false,
			statusCode: 401,
			error: 'Google profile name is missing'
		});
	});

	it('rejects an invalid or expired token and logs the underlying error', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const underlyingError = new Error('Token used too late');
		verifyIdToken.mockRejectedValue(underlyingError);
		const { resolveGoogleIdentity } = await import('./index.mjs');

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
		const { resolveGoogleIdentity } = await import('./index.mjs');

		expect(await resolveGoogleIdentity('any-token')).toEqual({
			ok: false,
			statusCode: 500,
			error: 'Google auth not configured'
		});
	});
});

describe('handler', () => {
	const baseEvent = { headers: {} };

	beforeEach(() => {
		vi.resetModules();
		verifyIdToken.mockReset();
		send.mockReset();
		process.env.GOOGLE_CLIENT_ID = 'test-client-id';
		process.env.TABLE_NAME = 'stagehopper-selections';
		process.env.MEMBERSHIPS_TABLE_NAME = 'stagehopper-room-memberships';
		verifyIdToken.mockResolvedValue({
			getPayload: () => ({ sub: '1234567890', name: 'Alex Example' })
		});
	});

	afterEach(() => {
		delete process.env.GOOGLE_CLIENT_ID;
		delete process.env.TABLE_NAME;
		delete process.env.MEMBERSHIPS_TABLE_NAME;
	});

	it('upserting a selection also writes a membership row, atomically with the selections write', async () => {
		send.mockResolvedValue({});
		const { handler } = await import('./index.mjs');

		const res = await handler({
			...baseEvent,
			routeKey: 'PUT /api/stagehopper/rooms/{roomId}/selections',
			pathParameters: { roomId: 'tmr26-abc123' },
			body: JSON.stringify({ name: 'Alex', color: '#e74c3c', selections: {}, googleIdToken: 'tok' })
		});

		expect(res.statusCode).toBe(200);
		const transactWrite = send.mock.calls.find(([cmd]) => cmd.__command === 'TransactWrite');
		const items = transactWrite[0].input.TransactItems;
		expect(items).toHaveLength(2);
		expect(items.find((i) => i.Put.TableName === 'stagehopper-selections').Put.Item).toMatchObject({
			roomId: 'tmr26-abc123',
			userId: 'google:1234567890',
			name: 'Alex',
			color: '#e74c3c'
		});
		const membershipPut = items.find((i) => i.Put.TableName === 'stagehopper-room-memberships').Put;
		expect(membershipPut.Item).toMatchObject({
			userId: 'google:1234567890',
			roomId: 'tmr26-abc123',
			name: 'Alex',
			color: '#e74c3c'
		});
		expect(typeof membershipPut.Item.updatedAt).toBe('number');
	});

	it('lists a user\'s rooms sorted by most recently active', async () => {
		send.mockResolvedValue({
			Items: [
				{ roomId: 'tmr26-aaa111', updatedAt: 5 },
				{ roomId: 'tmr26-bbb222', updatedAt: 10 }
			]
		});
		const { handler } = await import('./index.mjs');

		const res = await handler({
			...baseEvent,
			routeKey: 'POST /api/stagehopper/users/me/rooms',
			body: JSON.stringify({ googleIdToken: 'tok' })
		});

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual([
			{ roomId: 'tmr26-bbb222', updatedAt: 10 },
			{ roomId: 'tmr26-aaa111', updatedAt: 5 }
		]);
		const query = send.mock.calls.find(([cmd]) => cmd.__command === 'Query');
		expect(query[0].input.TableName).toBe('stagehopper-room-memberships');
	});

	it('follows LastEvaluatedKey to collect every page of a user\'s rooms', async () => {
		send
			.mockResolvedValueOnce({
				Items: [{ roomId: 'tmr26-aaa111', updatedAt: 5 }],
				LastEvaluatedKey: { userId: 'google:1234567890', roomId: 'tmr26-aaa111' }
			})
			.mockResolvedValueOnce({ Items: [{ roomId: 'tmr26-bbb222', updatedAt: 10 }] });
		const { handler } = await import('./index.mjs');

		const res = await handler({
			...baseEvent,
			routeKey: 'POST /api/stagehopper/users/me/rooms',
			body: JSON.stringify({ googleIdToken: 'tok' })
		});

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual([
			{ roomId: 'tmr26-bbb222', updatedAt: 10 },
			{ roomId: 'tmr26-aaa111', updatedAt: 5 }
		]);
		const queries = send.mock.calls.filter(([cmd]) => cmd.__command === 'Query');
		expect(queries).toHaveLength(2);
		expect(queries[1][0].input.ExclusiveStartKey).toEqual({
			userId: 'google:1234567890',
			roomId: 'tmr26-aaa111'
		});
	});

	it('lists rooms even when the Google token has no name claim', async () => {
		verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: '1234567890', name: '' }) });
		send.mockResolvedValue({ Items: [] });
		const { handler } = await import('./index.mjs');

		const res = await handler({
			...baseEvent,
			routeKey: 'POST /api/stagehopper/users/me/rooms',
			body: JSON.stringify({ googleIdToken: 'tok' })
		});

		expect(res.statusCode).toBe(200);
	});

	it('rejects listing rooms without a googleIdToken', async () => {
		const { handler } = await import('./index.mjs');

		const res = await handler({
			...baseEvent,
			routeKey: 'POST /api/stagehopper/users/me/rooms',
			body: JSON.stringify({})
		});

		expect(res.statusCode).toBe(400);
	});

	it('leaving a room deletes both the selections and membership rows in one atomic transaction', async () => {
		send.mockResolvedValue({});
		const { handler } = await import('./index.mjs');

		const res = await handler({
			...baseEvent,
			routeKey: 'DELETE /api/stagehopper/rooms/{roomId}/selections',
			pathParameters: { roomId: 'tmr26-abc123' },
			body: JSON.stringify({ googleIdToken: 'tok' })
		});

		expect(res.statusCode).toBe(200);
		const transactWrite = send.mock.calls.find(([cmd]) => cmd.__command === 'TransactWrite');
		const items = transactWrite[0].input.TransactItems;
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
		const { handler } = await import('./index.mjs');

		const res = await handler({
			...baseEvent,
			routeKey: 'DELETE /api/stagehopper/rooms/{roomId}/selections',
			pathParameters: { roomId: 'tmr26-abc123' },
			body: JSON.stringify({ googleIdToken: 'tok' })
		});

		expect(res.statusCode).toBe(200);
	});

	it('rejects leaving a room with an invalid roomId', async () => {
		const { handler } = await import('./index.mjs');

		const res = await handler({
			...baseEvent,
			routeKey: 'DELETE /api/stagehopper/rooms/{roomId}/selections',
			pathParameters: { roomId: '!!' },
			body: JSON.stringify({ googleIdToken: 'tok' })
		});

		expect(res.statusCode).toBe(400);
	});
});
