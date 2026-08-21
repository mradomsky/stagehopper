import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	addPushSubscription,
	checkAdmin,
	createRoom,
	deleteAdminRoom,
	deleteAdminUser,
	fetchRoomSelections,
	getNotificationSettings,
	importFestivalTimetable,
	leaveRoom,
	listAdminRooms,
	listAdminUsers,
	listMyRooms,
	patchFestivalTimetable,
	presignFestivalImage,
	presignFestivalMap,
	putRoomSelections,
	removePushSubscription,
	saveNotificationSettings,
	sendTestNotification,
	saveFestivals,
	uploadToPresignedUrl
} from './api.js';
import type { FestivalRecord, TimetableUpload } from './types.js';

const fetchMock = vi.fn();

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('fetchRoomSelections', () => {
	it('returns the parsed participant list', async () => {
		fetchMock.mockResolvedValue(jsonResponse([{ userId: 'google:1' }]));

		const result = await fetchRoomSelections('tmr26-abc123');

		expect(result).toEqual({ ok: true, data: [{ userId: 'google:1' }] });
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/stagehopper/rooms/tmr26-abc123/selections',
			undefined
		);
	});

	it('escapes the room id in the url', async () => {
		fetchMock.mockResolvedValue(jsonResponse([]));

		await fetchRoomSelections('room with space');

		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			'/api/stagehopper/rooms/room%20with%20space/selections'
		);
	});

	it('reports a failed request without throwing', async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, 500));

		expect(await fetchRoomSelections('tmr26-abc123')).toEqual({
			ok: false,
			unauthorized: false,
			status: 500
		});
	});

	it('reports a network error as status 0', async () => {
		fetchMock.mockRejectedValue(new TypeError('offline'));

		expect(await fetchRoomSelections('tmr26-abc123')).toEqual({
			ok: false,
			unauthorized: false,
			status: 0
		});
	});
});

describe('putRoomSelections', () => {
	it('sends the payload as JSON', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		await putRoomSelections('tmr26-abc123', {
			googleIdToken: 'tok',
			name: 'Alex',
			color: '#e74c3c',
			selections: { a: 1 }
		});

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('/api/stagehopper/rooms/tmr26-abc123/selections');
		expect(init).toMatchObject({
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' }
		});
		expect(JSON.parse(init.body)).toEqual({
			googleIdToken: 'tok',
			name: 'Alex',
			color: '#e74c3c',
			selections: { a: 1 }
		});
	});

	it('flags a rejected token so the caller can re-authenticate', async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, 401));

		expect(await putRoomSelections('tmr26-abc123', {
			googleIdToken: 'expired',
			name: 'Alex',
			color: '#e74c3c',
			selections: {}
		})).toEqual({ ok: false, unauthorized: true, status: 401 });
	});
});

describe('leaveRoom', () => {
	it('sends a DELETE carrying the id token', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		await leaveRoom('tmr26-abc123', 'tok');

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('/api/stagehopper/rooms/tmr26-abc123/selections');
		expect(init.method).toBe('DELETE');
		expect(JSON.parse(init.body)).toEqual({ googleIdToken: 'tok' });
	});
});

describe('createRoom', () => {
	it('posts the requested room id', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ roomId: 'tmr26-abc123' }, 201));

		const result = await createRoom('tmr26-abc123');

		expect(result).toEqual({ ok: true, data: { roomId: 'tmr26-abc123' } });
		expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/stagehopper/rooms');
	});
});

describe('listMyRooms', () => {
	it('posts the id token and returns the memberships', async () => {
		fetchMock.mockResolvedValue(jsonResponse([{ roomId: 'tmr26-abc123' }]));

		const result = await listMyRooms('tok');

		expect(result).toEqual({ ok: true, data: [{ roomId: 'tmr26-abc123' }] });
		expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/stagehopper/users/me/rooms');
	});
});

describe('checkAdmin', () => {
	it('posts the id token and reports the server verdict', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ isAdmin: true }));

		expect(await checkAdmin('tok')).toBe(true);

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('/api/stagehopper/admin/me');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body)).toEqual({ googleIdToken: 'tok' });
	});

	// Everything that is not an explicit yes has to read as no, or a failing backend would
	// hand out the admin UI to whoever happens to be signed in.
	it.each([
		['a 403 for a signed-in non-admin', jsonResponse({ isAdmin: false }, 403)],
		['a 401', jsonResponse({}, 401)],
		['a 500', jsonResponse({}, 500)],
		['a 200 that omits the flag', jsonResponse({})],
		['a 200 whose flag is merely truthy', jsonResponse({ isAdmin: 'yes' })]
	])('reports false for %s', async (_label, response) => {
		fetchMock.mockResolvedValue(response);

		expect(await checkAdmin('tok')).toBe(false);
	});

	it('reports false when the network is down', async () => {
		fetchMock.mockRejectedValue(new TypeError('offline'));

		expect(await checkAdmin('tok')).toBe(false);
	});
});

describe('saveFestivals', () => {
	const festivals: FestivalRecord[] = [
		{
			id: 'tmr26',
			name: 'Tomorrowland 2026 – Week 1',
			location: 'Boom, Belgium',
			startDate: '2026-07-17',
			endDate: '2026-07-20'
		}
	];

	it('PUTs the id token and the festival list', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true, festivals }));

		const result = await saveFestivals('tok', festivals);

		expect(result).toEqual({ ok: true, data: { ok: true, festivals } });
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('/api/stagehopper/admin/festivals');
		expect(init.method).toBe('PUT');
		expect(JSON.parse(init.body)).toEqual({ googleIdToken: 'tok', festivals });
	});

	it('flags a rejected token so the caller can re-authenticate', async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, 401));

		expect(await saveFestivals('tok', festivals)).toEqual({
			ok: false,
			unauthorized: true,
			status: 401
		});
	});
});

describe('presignFestivalImage', () => {
	it('posts the token, content type and length for the named festival', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ uploadUrl: 'https://s3.example/put', imageUrl: '/data/festival-images/x.jpg' })
		);

		const result = await presignFestivalImage('tok', 'tmr26', 'image/jpeg', 500_000);

		expect(result).toEqual({
			ok: true,
			data: { uploadUrl: 'https://s3.example/put', imageUrl: '/data/festival-images/x.jpg' }
		});
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('/api/stagehopper/admin/festivals/tmr26/image-upload');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body)).toEqual({
			googleIdToken: 'tok',
			contentType: 'image/jpeg',
			contentLength: 500_000
		});
	});

	it('escapes the festival id in the url', async () => {
		fetchMock.mockResolvedValue(jsonResponse({}));

		await presignFestivalImage('tok', 'a b', 'image/jpeg', 100);

		expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/stagehopper/admin/festivals/a%20b/image-upload');
	});

	it('reports a rejected content type without throwing', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ error: 'bad type' }, 400));

		expect(await presignFestivalImage('tok', 'tmr26', 'image/gif', 100)).toEqual({
			ok: false,
			unauthorized: false,
			status: 400,
			error: 'bad type'
		});
	});
});

describe('presignFestivalMap', () => {
	it('posts the token, content type and length for the named festival', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ uploadUrl: 'https://s3.example/put', imageUrl: '/data/festival-maps/x.jpg' })
		);

		const result = await presignFestivalMap('tok', 'tmr26', 'image/png', 2_000_000);

		expect(result).toEqual({
			ok: true,
			data: { uploadUrl: 'https://s3.example/put', imageUrl: '/data/festival-maps/x.jpg' }
		});
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('/api/stagehopper/admin/festivals/tmr26/map-upload');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body)).toEqual({
			googleIdToken: 'tok',
			contentType: 'image/png',
			contentLength: 2_000_000
		});
	});

	it('escapes the festival id in the url', async () => {
		fetchMock.mockResolvedValue(jsonResponse({}));

		await presignFestivalMap('tok', 'a b', 'image/webp', 100);

		expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/stagehopper/admin/festivals/a%20b/map-upload');
	});
});

describe('uploadToPresignedUrl', () => {
	it('PUTs the blob with its content type', async () => {
		fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
		const blob = new Blob(['bytes'], { type: 'image/jpeg' });

		const result = await uploadToPresignedUrl('https://s3.example/put', blob);

		expect(result).toBe(true);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('https://s3.example/put');
		expect(init).toMatchObject({ method: 'PUT', body: blob, headers: { 'Content-Type': 'image/jpeg' } });
	});

	it('reports false when S3 rejects the upload', async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });

		expect(await uploadToPresignedUrl('https://s3.example/put', new Blob())).toBe(false);
	});

	it('reports false when the network fails', async () => {
		fetchMock.mockRejectedValue(new TypeError('offline'));

		expect(await uploadToPresignedUrl('https://s3.example/put', new Blob())).toBe(false);
	});
});

describe('importFestivalTimetable', () => {
	const timetable: TimetableUpload = {
		formatVersion: 1,
		festivalId: 'tmr26',
		days: [
			{
				date: '2026-07-17',
				performances: [{ artist: 'A', stage: 'MAIN', startTime: '22:00', endTime: '23:00' }]
			}
		]
	};

	it('posts the token and the timetable to the named festival', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		const result = await importFestivalTimetable('tok', 'tmr26', timetable);

		expect(result).toEqual({ ok: true, data: { ok: true } });
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('/api/stagehopper/admin/festivals/tmr26/timetable-import');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body)).toEqual({ googleIdToken: 'tok', timetable });
	});

	it('surfaces a 409 so the caller can tell "already imported" apart from other failures', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ error: 'exists' }, 409));

		expect(await importFestivalTimetable('tok', 'tmr26', timetable)).toEqual({
			ok: false,
			unauthorized: false,
			status: 409,
			error: 'exists'
		});
	});
});

describe('patchFestivalTimetable', () => {
	it('PATCHes the token, id and patch to the named festival', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true, timetable: {} }));

		const result = await patchFestivalTimetable('tok', 'tmr26', 'p1', { artist: 'Updated' });

		expect(result).toEqual({ ok: true, data: { ok: true, timetable: {} } });
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('/api/stagehopper/admin/festivals/tmr26/timetable');
		expect(init.method).toBe('PATCH');
		expect(JSON.parse(init.body)).toEqual({
			googleIdToken: 'tok',
			performanceId: 'p1',
			patch: { artist: 'Updated' }
		});
	});

	it('sends patch: null to delete a performance, distinct from an absent patch', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true, timetable: {} }));

		await patchFestivalTimetable('tok', 'tmr26', 'p1', null);

		const [, init] = fetchMock.mock.calls[0] ?? [];
		const sent = JSON.parse(init.body);
		expect('patch' in sent).toBe(true);
		expect(sent.patch).toBeNull();
	});

	it('surfaces a 412 so the caller can tell "stale, please retry" apart from other failures', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ error: 'stale' }, 412));

		expect(await patchFestivalTimetable('tok', 'tmr26', 'p1', { artist: 'X' })).toEqual({
			ok: false,
			unauthorized: false,
			status: 412,
			error: 'stale'
		});
	});
});

describe('listAdminRooms', () => {
	it('posts the token and start key, returning rooms and the next cursor', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ rooms: [{ roomId: 'r1', participantCount: 2, updatedAt: 5 }], nextKey: { k: 1 } })
		);

		const result = await listAdminRooms('tok', { k: 0 });

		expect(result).toEqual({
			ok: true,
			data: { rooms: [{ roomId: 'r1', participantCount: 2, updatedAt: 5 }], nextKey: { k: 1 } }
		});
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('/api/stagehopper/admin/rooms');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body)).toEqual({ googleIdToken: 'tok', startKey: { k: 0 } });
	});
});

describe('listAdminUsers', () => {
	it('posts the token to the users endpoint', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ users: [], nextKey: null }));

		const result = await listAdminUsers('tok');

		expect(result).toEqual({ ok: true, data: { users: [], nextKey: null } });
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('/api/stagehopper/admin/users');
		expect(JSON.parse(init.body)).toEqual({ googleIdToken: 'tok' });
	});
});

describe('deleteAdminRoom', () => {
	it('DELETEs the room with the token in the body', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true, deleted: 4 }));

		const result = await deleteAdminRoom('tok', 'tmr26-a1b2c3');

		expect(result).toEqual({ ok: true, data: { ok: true, deleted: 4 } });
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('/api/stagehopper/admin/rooms/tmr26-a1b2c3');
		expect(init.method).toBe('DELETE');
		expect(JSON.parse(init.body)).toEqual({ googleIdToken: 'tok' });
	});
});

describe('deleteAdminUser', () => {
	it('DELETEs the url-encoded user id', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true, deleted: 2 }));

		await deleteAdminUser('tok', 'google:123');

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('/api/stagehopper/admin/users/google%3A123');
		expect(init.method).toBe('DELETE');
	});
});

describe('sendTestNotification', () => {
	it('POSTs to the url-encoded user id and returns the counts', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true, sent: 1, total: 1 }));

		const result = await sendTestNotification('tok', 'google:123');

		expect(result).toEqual({ ok: true, data: { ok: true, sent: 1, total: 1 } });
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('/api/stagehopper/admin/users/google%3A123/test-notification');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body)).toEqual({ googleIdToken: 'tok' });
	});
});

describe('getNotificationSettings', () => {
	it('posts the token and returns the settings', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				leadMinutes: 15,
				notifyMaybe: false,
				notifyOverrides: { perf1: true },
				enabled: true,
				subscribedHere: true
			})
		);

		const result = await getNotificationSettings('tok');

		expect(result).toEqual({
			ok: true,
			data: {
				leadMinutes: 15,
				notifyMaybe: false,
				notifyOverrides: { perf1: true },
				enabled: true,
				subscribedHere: true
			}
		});
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('/api/stagehopper/users/me/notifications');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body)).toEqual({ googleIdToken: 'tok' });
	});

	it('includes endpoint when provided', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ leadMinutes: 15, notifyMaybe: true }));

		await getNotificationSettings('tok', 'https://example.com/push/ep1');

		const [, init] = fetchMock.mock.calls[0] ?? [];
		expect(JSON.parse(init.body)).toEqual({
			googleIdToken: 'tok',
			endpoint: 'https://example.com/push/ep1'
		});
	});

	it('flags a rejected token', async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, 401));

		expect(await getNotificationSettings('expired')).toEqual({
			ok: false,
			unauthorized: true,
			status: 401
		});
	});
});

describe('saveNotificationSettings', () => {
	it('puts the token and settings', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				leadMinutes: 30,
				notifyMaybe: true,
				enabled: true,
				subscribedHere: true
			})
		);

		const result = await saveNotificationSettings('tok', {
			leadMinutes: 30,
			notifyMaybe: true
		});

		expect(result).toEqual({
			ok: true,
			data: expect.objectContaining({
				leadMinutes: 30,
				notifyMaybe: true
			})
		});
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('/api/stagehopper/users/me/notifications');
		expect(init.method).toBe('PUT');
		expect(JSON.parse(init.body)).toEqual({
			googleIdToken: 'tok',
			leadMinutes: 30,
			notifyMaybe: true
		});
	});

	it('flags a rejected token', async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, 401));

		expect(
			await saveNotificationSettings('expired', {
				leadMinutes: 15,
				notifyMaybe: false
			})
		).toEqual({
			ok: false,
			unauthorized: true,
			status: 401
		});
	});
});

describe('addPushSubscription', () => {
	it('posts the token and subscription', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		const result = await addPushSubscription('tok', {
			endpoint: 'https://example.com/push/ep1',
			keys: {
				p256dh: 'key1',
				auth: 'auth1'
			}
		});

		expect(result).toEqual({ ok: true, data: { ok: true } });
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('/api/stagehopper/users/me/notifications/subscription');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body)).toEqual({
			googleIdToken: 'tok',
			subscription: {
				endpoint: 'https://example.com/push/ep1',
				keys: {
					p256dh: 'key1',
					auth: 'auth1'
				}
			}
		});
	});

	it('flags a rejected token', async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, 401));

		expect(
			await addPushSubscription('expired', {
				endpoint: 'https://example.com/push/ep1',
				keys: { p256dh: 'key1', auth: 'auth1' }
			})
		).toEqual({
			ok: false,
			unauthorized: true,
			status: 401
		});
	});
});

describe('removePushSubscription', () => {
	it('deletes the token and endpoint', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		const result = await removePushSubscription('tok', 'https://example.com/push/ep1');

		expect(result).toEqual({ ok: true, data: { ok: true } });
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe('/api/stagehopper/users/me/notifications/subscription');
		expect(init.method).toBe('DELETE');
		expect(JSON.parse(init.body)).toEqual({
			googleIdToken: 'tok',
			endpoint: 'https://example.com/push/ep1'
		});
	});

	it('flags a rejected token', async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, 401));

		expect(await removePushSubscription('expired', 'https://example.com/push/ep1')).toEqual({
			ok: false,
			unauthorized: true,
			status: 401
		});
	});
});
