import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// web-push is the only send side effect; capture its calls.
const setVapidDetails = vi.fn();
const sendNotification = vi.fn();
const send = vi.fn();
const s3Send = vi.fn();
const ssmSend = vi.fn();

vi.mock('web-push', () => ({
	default: { setVapidDetails, sendNotification }
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
	DynamoDBClient: class {}
}));

vi.mock('@aws-sdk/lib-dynamodb', () => {
	class Command {
		constructor(public input: Record<string, unknown>) {}
	}
	return {
		DynamoDBDocumentClient: { from: () => ({ send }) },
		QueryCommand: class extends Command {
			__command = 'Query';
		},
		ScanCommand: class extends Command {
			__command = 'Scan';
		},
		GetCommand: class extends Command {
			__command = 'Get';
		},
		PutCommand: class extends Command {
			__command = 'Put';
		},
		DeleteCommand: class extends Command {
			__command = 'Delete';
		}
	};
});

vi.mock('@aws-sdk/client-s3', () => ({
	S3Client: class {
		send = s3Send;
	},
	GetObjectCommand: class {
		__command = 'GetObject';
		constructor(public input: Record<string, unknown>) {}
	}
}));

// Mocked at the SDK boundary rather than at ./secrets.js, so the caching and
// error handling in that module stay under test.
vi.mock('@aws-sdk/client-ssm', () => ({
	SSMClient: class {
		send = ssmSend;
	},
	GetParameterCommand: class {
		__command = 'GetParameter';
		constructor(public input: Record<string, unknown>) {}
	}
}));

interface MockCommand {
	__command: string;
	input: Record<string, any>;
}

function commandsOfType(type: string): MockCommand[] {
	return send.mock.calls
		.map(([command]) => command as MockCommand)
		.filter((command) => command?.__command === type);
}

/** An S3 body whose transformToString resolves to `text`. */
function s3Body(text: string) {
	return { Body: { transformToString: async () => text } };
}

/** A festival happening on the frozen clock's date, in Berlin time. */
const FESTIVALS = [
	{ id: 'tmr26', name: 'TMR', timezone: 'Europe/Berlin', startDate: '2026-07-18', endDate: '2026-07-19' }
];

/** One 22:00 set — Berlin summer (+2h) → 20:00 UTC. */
const TIMETABLE = {
	days: [
		{
			date: '2026-07-18',
			performances: [{ id: 'perf1', artist: 'Artist', stage: 'Main', startTime: '22:00' }]
		}
	]
};

/**
 * Route S3 reads by key; DynamoDB reads by command type + table. A single mark of the
 * given `state` for perf1, in one room, for one enabled user with the given settings.
 */
function wireHappyPath(state: number, settings: Record<string, unknown>) {
	s3Send.mockImplementation((cmd: MockCommand) => {
		if (cmd.input.Key === 'data/festivals.json') return Promise.resolve(s3Body(JSON.stringify(FESTIVALS)));
		return Promise.resolve(s3Body(JSON.stringify(TIMETABLE)));
	});

	send.mockImplementation((cmd: MockCommand) => {
		switch (cmd.__command) {
			case 'Scan': // users table, notification-enabled — rooms live on the same row
				return Promise.resolve({
					Items: [
						{ userId: 'google:1', enabled: true, rooms: { 'tmr26-aaa': { updatedAt: 5 } }, ...settings }
					]
				});
			case 'Query': // push subscriptions, by userId
				return Promise.resolve({
					Items: [{ endpoint: 'https://push/x', keys: { p256dh: 'p', auth: 'a' } }]
				});
			case 'Get': // selection row
				return Promise.resolve({ Item: { selections: { perf1: state } } });
			case 'Put': // dedup conditional put — treat as new
				return Promise.resolve({});
			case 'Delete':
				return Promise.resolve({});
			default:
				return Promise.resolve({});
		}
	});
}

async function loadNotifier() {
	return import('./notifier.js');
}

describe('notifier', () => {
	beforeEach(() => {
		vi.resetModules();
		send.mockReset();
		s3Send.mockReset();
		ssmSend.mockReset().mockResolvedValue({ Parameter: { Value: 'priv' } });
		setVapidDetails.mockReset();
		sendNotification.mockReset().mockResolvedValue(undefined);

		process.env.TABLE_NAME = 'selections';
		process.env.USERS_TABLE = 'users';
		process.env.PUSH_SUBSCRIPTIONS_TABLE = 'push-subscriptions';
		process.env.NOTIF_DEDUP_TABLE = 'notif-dedup';
		process.env.SITE_BUCKET = 'site-bucket';
		process.env.VAPID_PRIVATE_KEY_PARAM = '/stagehopper/vapid-private-key';
		process.env.VAPID_PUBLIC_KEY = 'pub';
		process.env.VAPID_SUBJECT = 'mailto:a@b.co';

		// Frozen 15 minutes before the 22:00 (Berlin) set = 19:45 UTC, so sendAt is due.
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-18T19:45:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
		for (const k of [
			'TABLE_NAME',
			'USERS_TABLE',
			'PUSH_SUBSCRIPTIONS_TABLE',
			'NOTIF_DEDUP_TABLE',
			'SITE_BUCKET',
			'VAPID_PRIVATE_KEY_PARAM',
			'VAPID_PUBLIC_KEY',
			'VAPID_SUBJECT'
		])
			delete process.env[k];
	});

	describe('admin test send', () => {
		it('pushes a canned notification to every device and returns per-device counts', async () => {
			send.mockImplementation((cmd: MockCommand) => {
				if (cmd.__command === 'Query') {
					return Promise.resolve({
						Items: [
							{ endpoint: 'https://push/a', keys: { p256dh: 'p1', auth: 'a1' } },
							{ endpoint: 'https://push/b', keys: { p256dh: 'p2', auth: 'a2' } }
						]
					});
				}
				return Promise.resolve({});
			});
			const { handler } = await loadNotifier();

			const result = await handler({ test: true, userId: 'google:1' });

			expect(result).toEqual({ ok: true, sent: 2, failed: 0, total: 2 });
			expect(sendNotification).toHaveBeenCalledTimes(2);
			const [, payload] = sendNotification.mock.calls[0] ?? [];
			expect(JSON.parse(payload)).toMatchObject({ performanceId: 'test', artist: 'StageHopper test' });
			// The scheduled scan must not run on a test invoke.
			expect(commandsOfType('Scan')).toHaveLength(0);
		});

		it('reports ok:false when the user has no subscriptions', async () => {
			send.mockResolvedValue({ Items: [] });
			const { handler } = await loadNotifier();

			const result = await handler({ test: true, userId: 'google:1' });

			expect(result).toMatchObject({ ok: false, total: 0 });
			expect(sendNotification).not.toHaveBeenCalled();
		});

		it('reports ok:false when userId is missing', async () => {
			const { handler } = await loadNotifier();

			const result = await handler({ test: true });

			expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/userId/i) });
			expect(sendNotification).not.toHaveBeenCalled();
		});
	});

	it('exits without sending when no festival is happening', async () => {
		s3Send.mockResolvedValue(s3Body(JSON.stringify([]))); // empty festivals.json
		const { handler } = await loadNotifier();

		await handler();

		expect(sendNotification).not.toHaveBeenCalled();
	});

	it('sends a push for a due, qualifying attending mark and writes a dedup marker', async () => {
		wireHappyPath(1, { leadMinutes: 15, notifyMaybe: false });
		const { handler } = await loadNotifier();

		await handler();

		expect(commandsOfType('Put')).toHaveLength(1); // dedup conditional put
		expect(commandsOfType('Put')[0]?.input.TableName).toBe('notif-dedup');
		expect(sendNotification).toHaveBeenCalledTimes(1);
		const [subscription, payload] = sendNotification.mock.calls[0] ?? [];
		expect(subscription).toMatchObject({ endpoint: 'https://push/x', keys: { p256dh: 'p', auth: 'a' } });
		expect(JSON.parse(payload)).toMatchObject({
			performanceId: 'perf1',
			roomId: 'tmr26-aaa',
			artist: 'Artist',
			stage: 'Main'
		});
	});

	it('signs with the VAPID key fetched from SSM, decrypted, and fetches it once', async () => {
		wireHappyPath(1, { leadMinutes: 15, notifyMaybe: false });
		const { handler } = await loadNotifier();

		await handler();
		await handler();

		expect(setVapidDetails).toHaveBeenCalledWith('mailto:a@b.co', 'pub', 'priv');
		const request = ssmSend.mock.calls[0]?.[0] as { input: Record<string, unknown> };
		expect(request?.input).toMatchObject({
			Name: '/stagehopper/vapid-private-key',
			WithDecryption: true
		});
		// Cached for the life of the container: a warm invocation must not call SSM again.
		expect(ssmSend).toHaveBeenCalledTimes(1);
	});

	it('does not send when the mark is "maybe" but notifyMaybe is off', async () => {
		wireHappyPath(2, { leadMinutes: 15, notifyMaybe: false });
		const { handler } = await loadNotifier();

		await handler();

		expect(sendNotification).not.toHaveBeenCalled();
		expect(commandsOfType('Put')).toHaveLength(0);
	});

	it('sends for a "going" mark with no notifyMaybe/override settings at all — going has no toggle', async () => {
		wireHappyPath(1, { leadMinutes: 15 });
		const { handler } = await loadNotifier();

		await handler();

		expect(sendNotification).toHaveBeenCalledTimes(1);
	});

	it('a per-performance override:false suppresses a "going" mark that would otherwise send', async () => {
		wireHappyPath(1, { leadMinutes: 15, notifyOverrides: { perf1: false } });
		const { handler } = await loadNotifier();

		await handler();

		expect(sendNotification).not.toHaveBeenCalled();
		expect(commandsOfType('Put')).toHaveLength(0);
	});

	it('a per-performance override:true wakes a "maybe" mark despite notifyMaybe being off', async () => {
		wireHappyPath(2, { leadMinutes: 15, notifyMaybe: false, notifyOverrides: { perf1: true } });
		const { handler } = await loadNotifier();

		await handler();

		expect(sendNotification).toHaveBeenCalledTimes(1);
	});

	it("an override on a different performance doesn't affect this one", async () => {
		wireHappyPath(1, { leadMinutes: 15, notifyOverrides: { 'some-other-perf': false } });
		const { handler } = await loadNotifier();

		await handler();

		expect(sendNotification).toHaveBeenCalledTimes(1);
	});

	it('rolls back the dedup marker when every send fails transiently', async () => {
		wireHappyPath(1, { leadMinutes: 15, notifyMaybe: false });
		sendNotification.mockRejectedValue(Object.assign(new Error('boom'), { statusCode: 500 }));
		const { handler } = await loadNotifier();

		await handler();

		const dedupDeletes = commandsOfType('Delete').filter((c) => c.input.TableName === 'notif-dedup');
		expect(dedupDeletes).toHaveLength(1);
		expect(dedupDeletes[0]?.input.Key).toMatchObject({ userId: 'google:1', performanceId: 'perf1' });
	});

	it('keeps the dedup marker when at least one send succeeds', async () => {
		wireHappyPath(1, { leadMinutes: 15, notifyMaybe: false });
		const { handler } = await loadNotifier();

		await handler();

		const dedupDeletes = commandsOfType('Delete').filter((c) => c.input.TableName === 'notif-dedup');
		expect(dedupDeletes).toHaveLength(0);
	});

	it('prunes a subscription that returns 410 Gone', async () => {
		wireHappyPath(1, { leadMinutes: 15, notifyMaybe: false });
		sendNotification.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }));
		const { handler } = await loadNotifier();

		await handler();

		const del = commandsOfType('Delete')[0];
		expect(del?.input.TableName).toBe('push-subscriptions');
		expect(del?.input.Key).toMatchObject({ userId: 'google:1', endpoint: 'https://push/x' });
	});
});
