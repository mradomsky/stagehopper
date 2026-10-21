import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getApiToken = vi.fn();

// Clerk is mocked at its narrowest surface. `api.ts` asks for one bearer token per call and
// knows nothing else about the session, so a stub that returns a string (or null) covers
// the whole contract between them.
vi.mock('./auth.svelte.js', () => ({
	getApiToken: () => getApiToken()
}));

const {
	addPushSubscription,
	checkAdmin,
	createFestival,
	deleteAdminUser,
	banAdminUser,
	unbanAdminUser,
	deleteFestival,
	deleteFestivalMessage,
	fetchAdminFestivals,
	fetchFestivalMessages,
	fetchFestivalSummary,
	fetchProfile,
	putProfileColour,
	getNotificationSettings,
	importFestivalTimetable,
	listAdminUsers,
	patchFestivalTimetable,
	presignFestivalImage,
	postFestivalMessage,
	presignFestivalMap,
	removePushSubscription,
	saveNotificationOverride,
	saveNotificationSettings,
	sendTestNotification,
	updateFestival,
	uploadToPresignedUrl
} = await import('./api.js');

import type { FestivalRecord, TimetableUpload } from './types.js';

const fetchMock = vi.fn();

beforeEach(() => {
	fetchMock.mockReset();
	getApiToken.mockReset().mockResolvedValue('clerk-jwt');
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** The (url, init) the single fetch was made with. */
function lastCall(): [string, RequestInit & { body?: string }] {
	return fetchMock.mock.calls[0] as [string, RequestInit & { body?: string }];
}

function bodyOf(init: { body?: string }): unknown {
	return JSON.parse(init.body ?? 'null');
}

// The property that replaced every `googleIdToken` field in this file: the credential is a
// header, minted per request, and never appears in a payload.
describe('request signing', () => {
	it('sends the token as a bearer header, not in the body', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		await putProfileColour('#e74c3c');

		const [, init] = lastCall();
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer clerk-jwt');
		expect(bodyOf(init)).toEqual({ colour: '#e74c3c' });
	});

	it('mints a fresh token for every call rather than reusing one', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
		getApiToken.mockResolvedValueOnce('first').mockResolvedValueOnce('second');

		await fetchProfile();
		await fetchProfile();

		const headers = fetchMock.mock.calls.map(
			([, init]) => (init.headers as Record<string, string>).Authorization
		);
		expect(headers).toEqual(['Bearer first', 'Bearer second']);
	});

	// No session means no request at all. The gateway would answer 401 anyway; reporting it
	// without the round trip is what lets `checkAdmin` decide instantly on a signed-out load.
	it('reports 401 without calling the network when there is no session', async () => {
		getApiToken.mockResolvedValue(null);

		expect(await fetchProfile()).toEqual({ ok: false, unauthorized: true, status: 401 });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('omits a content type on a request with no body', async () => {
		fetchMock.mockResolvedValue(jsonResponse([]));

		await fetchProfile();

		const [, init] = lastCall();
		expect(init.headers).toEqual({ Authorization: 'Bearer clerk-jwt' });
		expect(init.body).toBeUndefined();
	});
});

describe('fetchFestivalSummary', () => {
	const htmlResponse = () => ({
		ok: true,
		status: 200,
		json: async () => {
			throw new SyntaxError('Unexpected token <');
		}
	});

	// Public read: signed out visitors call it, so no credential may ride along.
	it('GETs the summary without an Authorization header', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ attendees: 12, latestMessage: { handle: 'ana', text: 'hi' } })
		);

		const result = await fetchFestivalSummary('tmr26');

		const [url, init] = lastCall();
		expect(url).toBe('/api/stagehopper/festivals/tmr26/summary');
		expect(JSON.stringify(init ?? {})).not.toMatch(/authorization/i);
		expect(getApiToken).not.toHaveBeenCalled();
		expect(result).toEqual({
			ok: true,
			data: { attendees: 12, latestMessage: { handle: 'ana', text: 'hi' } }
		});
	});

	it('accepts a null latest message', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ attendees: 0, latestMessage: null }));

		expect(await fetchFestivalSummary('tmr26')).toEqual({
			ok: true,
			data: { attendees: 0, latestMessage: null }
		});
	});

	it('fails on a 200 text/html body (unwired route)', async () => {
		fetchMock.mockResolvedValue(htmlResponse());

		expect((await fetchFestivalSummary('tmr26')).ok).toBe(false);
	});

	it.each([
		['non-object', 'oops'],
		['null', null],
		['missing attendees', { latestMessage: null }],
		['negative attendees', { attendees: -1, latestMessage: null }],
		['fractional attendees', { attendees: 1.5, latestMessage: null }],
		['string attendees', { attendees: '3', latestMessage: null }],
		['missing latestMessage', { attendees: 3 }],
		['message without text', { attendees: 3, latestMessage: { handle: 'ana' } }],
		['message without handle', { attendees: 3, latestMessage: { text: 'hi' } }]
	])('fails on a wrong-shape body: %s', async (_name, body) => {
		fetchMock.mockResolvedValue(jsonResponse(body));

		expect((await fetchFestivalSummary('tmr26')).ok).toBe(false);
	});

	it('fails on a server error', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));

		expect((await fetchFestivalSummary('tmr26')).ok).toBe(false);
	});
});

describe('checkAdmin', () => {
	it('GETs the verdict and reports it', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ isAdmin: true }));

		expect(await checkAdmin()).toBe(true);

		const [url, init] = lastCall();
		expect(url).toBe('/api/stagehopper/admin/me');
		expect(init.method).toBe('GET');
	});

	it('reports false for a signed-in non-admin', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ isAdmin: false, error: 'Not an admin' }, 403));

		expect(await checkAdmin()).toBe(false);
	});

	it('reports false when the network is down', async () => {
		fetchMock.mockRejectedValue(new TypeError('offline'));

		expect(await checkAdmin()).toBe(false);
	});

	// This is what lets the admin layout redirect a signed-out visitor immediately: the
	// answer is false before any request is attempted.
	it('reports false without a request when there is no session', async () => {
		getApiToken.mockResolvedValue(null);

		expect(await checkAdmin()).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('fetchAdminFestivals', () => {
	// This route could not exist while the credential rode in a body: `fetch` refuses to
	// send one on a GET.
	it('GETs the published list', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ festivals: [] }));

		const result = await fetchAdminFestivals();

		const [url, init] = lastCall();
		expect(url).toBe('/api/stagehopper/admin/festivals');
		expect(init.method).toBe('GET');
		expect(result).toEqual({ ok: true, data: { festivals: [] } });
	});
});

describe('createFestival', () => {
	const festival: FestivalRecord = {
		id: 'tmr26',
		name: 'Tomorrowland 2026',
		location: 'Boom',
		startDate: '2026-07-17',
		endDate: '2026-07-20',
		timezone: 'Europe/Brussels'
	};

	it('POSTs the new festival', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true, festival }));

		await createFestival(festival);

		const [url, init] = lastCall();
		expect(url).toBe('/api/stagehopper/admin/festivals');
		expect(init.method).toBe('POST');
		expect(bodyOf(init)).toEqual(festival);
	});

	it('flags a rejected session so the caller can re-authenticate', async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, 401));

		expect(await createFestival(festival)).toEqual({
			ok: false,
			unauthorized: true,
			status: 401
		});
	});
});

describe('updateFestival', () => {
	const festival: FestivalRecord = {
		id: 'tmr26',
		name: 'Tomorrowland 2026',
		location: 'Boom',
		startDate: '2026-07-17',
		endDate: '2026-07-20',
		timezone: 'Europe/Brussels'
	};

	it('PATCHes the festival at its id', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true, festival }));

		await updateFestival(festival);

		const [url, init] = lastCall();
		expect(url).toBe('/api/stagehopper/admin/festivals/tmr26');
		expect(init.method).toBe('PATCH');
		expect(bodyOf(init)).toEqual(festival);
	});
});

describe('deleteFestival', () => {
	it('DELETEs the festival at its id', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		await deleteFestival('tmr26');

		const [url, init] = lastCall();
		expect(url).toBe('/api/stagehopper/admin/festivals/tmr26');
		expect(init.method).toBe('DELETE');
	});
});

describe('presignFestivalImage', () => {
	it('posts the content type and length for the named festival', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ uploadUrl: 'https://s3/put', imageUrl: '/data/festival-images/x.jpg' })
		);

		const result = await presignFestivalImage('tmr26', 'image/jpeg', 1234);

		const [url, init] = lastCall();
		expect(url).toBe('/api/stagehopper/admin/festivals/tmr26/image-upload');
		expect(init.method).toBe('POST');
		expect(bodyOf(init)).toEqual({ contentType: 'image/jpeg', contentLength: 1234 });
		expect(result).toEqual({
			ok: true,
			data: { uploadUrl: 'https://s3/put', imageUrl: '/data/festival-images/x.jpg' }
		});
	});

	it('escapes the festival id in the url', async () => {
		fetchMock.mockResolvedValue(jsonResponse({}));

		await presignFestivalImage('a b', 'image/png', 1);

		expect(lastCall()[0]).toBe('/api/stagehopper/admin/festivals/a%20b/image-upload');
	});

	it('reports a rejected content type without throwing', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ error: 'contentType must be one of' }, 400));

		expect(await presignFestivalImage('tmr26', 'image/gif', 1)).toEqual({
			ok: false,
			unauthorized: false,
			status: 400,
			error: 'contentType must be one of'
		});
	});
});

describe('presignFestivalMap', () => {
	it('posts the content type and length for the named festival', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ uploadUrl: 'https://s3/put', imageUrl: '/data/festival-maps/x.png' })
		);

		const result = await presignFestivalMap('tmr26', 'image/png', 4321);

		const [url, init] = lastCall();
		expect(url).toBe('/api/stagehopper/admin/festivals/tmr26/map-upload');
		expect(bodyOf(init)).toEqual({ contentType: 'image/png', contentLength: 4321 });
		expect(result.ok).toBe(true);
	});

	it('escapes the festival id in the url', async () => {
		fetchMock.mockResolvedValue(jsonResponse({}));

		await presignFestivalMap('a b', 'image/png', 1);

		expect(lastCall()[0]).toBe('/api/stagehopper/admin/festivals/a%20b/map-upload');
	});
});

describe('uploadToPresignedUrl', () => {
	// The bytes go straight to S3 on a signature that already encodes the constraints, so
	// this deliberately carries no Clerk token.
	it('PUTs the blob with its content type and no bearer header', async () => {
		fetchMock.mockResolvedValue({ ok: true, status: 200 });
		const blob = new Blob(['x'], { type: 'image/jpeg' });

		expect(await uploadToPresignedUrl('https://s3/put', blob)).toBe(true);

		const [url, init] = lastCall();
		expect(url).toBe('https://s3/put');
		expect(init).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } });
		expect(getApiToken).not.toHaveBeenCalled();
	});

	it('reports false when S3 rejects the upload', async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 403 });

		expect(await uploadToPresignedUrl('https://s3/put', new Blob(['x']))).toBe(false);
	});

	it('reports false when the network fails', async () => {
		fetchMock.mockRejectedValue(new TypeError('offline'));

		expect(await uploadToPresignedUrl('https://s3/put', new Blob(['x']))).toBe(false);
	});
});

describe('importFestivalTimetable', () => {
	const timetable: TimetableUpload = {
		formatVersion: 1,
		festivalId: 'tmr26',
		days: [
			{
				date: '2026-07-17',
				performances: [
					{ artist: 'A', stage: 'Main', startTime: '20:00', endTime: '21:00' }
				]
			}
		]
	};

	it('posts the timetable to the named festival', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		await importFestivalTimetable('tmr26', timetable);

		const [url, init] = lastCall();
		expect(url).toBe('/api/stagehopper/admin/festivals/tmr26/timetable-import');
		expect(init.method).toBe('POST');
		expect(bodyOf(init)).toEqual({ timetable });
	});

	it('surfaces a 409 so the caller can tell "already imported" apart from other failures', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ error: 'A timetable already exists' }, 409));

		expect(await importFestivalTimetable('tmr26', timetable)).toEqual({
			ok: false,
			unauthorized: false,
			status: 409,
			error: 'A timetable already exists'
		});
	});
});

describe('patchFestivalTimetable', () => {
	it('PATCHes the id and patch to the named festival', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true, timetable: { festivalId: 'tmr26', days: [] } }));

		await patchFestivalTimetable('tmr26', 'p1', { artist: 'B' });

		const [url, init] = lastCall();
		expect(url).toBe('/api/stagehopper/admin/festivals/tmr26/timetable');
		expect(init.method).toBe('PATCH');
		expect(bodyOf(init)).toEqual({ performanceId: 'p1', patch: { artist: 'B' } });
	});

	it('sends patch: null to delete a performance, distinct from an absent patch', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true, timetable: { festivalId: 'tmr26', days: [] } }));

		await patchFestivalTimetable('tmr26', 'p1', null);

		expect(bodyOf(lastCall()[1])).toEqual({ performanceId: 'p1', patch: null });
	});

	it('surfaces a 412 so the caller can tell "stale, please retry" apart from other failures', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ error: 'changed' }, 412));

		expect(await patchFestivalTimetable('tmr26', 'p1', {})).toMatchObject({
			ok: false,
			status: 412
		});
	});
});

describe('deleteAdminUser', () => {
	it('DELETEs the url-encoded user id', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		await deleteAdminUser('clerk:user_123');

		expect(lastCall()[0]).toBe('/api/stagehopper/admin/users/clerk%3Auser_123');
	});
});

describe('banAdminUser / unbanAdminUser', () => {
	it('POSTs the ban to the url-encoded user id and returns the new state', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true, userId: 'clerk:user_123', banned: true }));

		const result = await banAdminUser('clerk:user_123');

		const [url, init] = lastCall();
		expect(url).toBe('/api/stagehopper/admin/users/clerk%3Auser_123/ban');
		expect(init.method).toBe('POST');
		expect(result).toEqual({ ok: true, data: { ok: true, userId: 'clerk:user_123', banned: true } });
	});

	it('DELETEs the ban to unban', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true, userId: 'clerk:user_123', banned: false }));

		await unbanAdminUser('clerk:user_123');

		const [url, init] = lastCall();
		expect(url).toBe('/api/stagehopper/admin/users/clerk%3Auser_123/ban');
		expect(init.method).toBe('DELETE');
	});

	it('reports an unrouted path (HTML 200) as status 0, not ok', async () => {
		fetchMock.mockResolvedValue(new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }));

		const result = await banAdminUser('clerk:user_123');

		expect(result).toMatchObject({ ok: false, status: 0 });
	});
});

describe('sendTestNotification', () => {
	it('POSTs to the url-encoded user id and returns the counts', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true, sent: 1, total: 2 }));

		const result = await sendTestNotification('clerk:user_123');

		const [url, init] = lastCall();
		expect(url).toBe('/api/stagehopper/admin/users/clerk%3Auser_123/test-notification');
		expect(init.method).toBe('POST');
		expect(result).toEqual({ ok: true, data: { ok: true, sent: 1, total: 2 } });
	});
});

describe('getNotificationSettings', () => {
	// Kept a POST with a body, unlike the other reads: the endpoint is a long opaque
	// push-service URL that has no business in a query string.
	it('posts and returns the settings', async () => {
		const settings = {
			leadMinutes: 15,
			notifyMaybe: false,
			notifyOverrides: { perf1: true },
			enabled: true,
			subscribedHere: true
		};
		fetchMock.mockResolvedValue(jsonResponse(settings));

		const result = await getNotificationSettings();

		const [url, init] = lastCall();
		expect(url).toBe('/api/stagehopper/users/me/notifications');
		expect(init.method).toBe('POST');
		expect(result).toEqual({ ok: true, data: settings });
	});

	it('includes endpoint when provided', async () => {
		fetchMock.mockResolvedValue(jsonResponse({}));

		await getNotificationSettings('https://push/abc');

		expect(bodyOf(lastCall()[1])).toEqual({ endpoint: 'https://push/abc' });
	});

	it('flags a rejected session', async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, 401));

		expect(await getNotificationSettings()).toMatchObject({ ok: false, unauthorized: true });
	});
});

describe('saveNotificationSettings', () => {
	const prefs = { leadMinutes: 30, notifyMaybe: true };

	it('puts the settings', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ leadMinutes: 30, notifyMaybe: true, enabled: true, subscribedHere: true })
		);

		const result = await saveNotificationSettings(prefs);

		const [url, init] = lastCall();
		expect(url).toBe('/api/stagehopper/users/me/notifications');
		expect(init.method).toBe('PUT');
		expect(bodyOf(init)).toEqual(prefs);
		expect(result).toEqual({
			ok: true,
			data: expect.objectContaining({ leadMinutes: 30, notifyMaybe: true })
		});
	});

	it('flags a rejected session', async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, 401));

		expect(await saveNotificationSettings(prefs)).toMatchObject({
			ok: false,
			unauthorized: true
		});
	});
});

describe('saveNotificationOverride', () => {
	it('puts a sparse patch keyed by performance id', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		const result = await saveNotificationOverride('perf1', false);

		expect(result).toEqual({ ok: true, data: { ok: true } });
		const [url, init] = lastCall();
		expect(url).toBe('/api/stagehopper/users/me/notifications');
		expect(init.method).toBe('PUT');
		expect(bodyOf(init)).toEqual({ notifyOverrides: { perf1: false } });
	});

	it('sends null to clear an override', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		await saveNotificationOverride('perf1', null);

		expect(bodyOf(lastCall()[1])).toEqual({ notifyOverrides: { perf1: null } });
	});

	it('flags a rejected session', async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, 401));

		expect(await saveNotificationOverride('perf1', true)).toEqual({
			ok: false,
			unauthorized: true,
			status: 401
		});
	});
});

describe('addPushSubscription', () => {
	const sub = { endpoint: 'https://push/abc', keys: { p256dh: 'p', auth: 'a' } };

	it('posts the subscription', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		await addPushSubscription(sub);

		const [url, init] = lastCall();
		expect(url).toBe('/api/stagehopper/users/me/notifications/subscription');
		expect(init.method).toBe('POST');
		expect(bodyOf(init)).toEqual({ subscription: sub });
	});

	it('flags a rejected session', async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, 401));

		expect(await addPushSubscription(sub)).toMatchObject({ ok: false, unauthorized: true });
	});
});

describe('removePushSubscription', () => {
	it('deletes the endpoint', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

		await removePushSubscription('https://push/abc');

		const [url, init] = lastCall();
		expect(url).toBe('/api/stagehopper/users/me/notifications/subscription');
		expect(init.method).toBe('DELETE');
		expect(bodyOf(init)).toEqual({ endpoint: 'https://push/abc' });
	});

	it('flags a rejected session', async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, 401));

		expect(await removePushSubscription('https://push/abc')).toMatchObject({
			ok: false,
			unauthorized: true
		});
	});
});

describe('festival chat', () => {
	it('reads Messages without a token, newest page by default', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ messages: [] }));
		await fetchFestivalMessages('tmr26');
		const [url, init] = lastCall();
		expect(url.endsWith('/festivals/tmr26/messages')).toBe(true);
		expect(init?.headers).toBeUndefined();
		expect(getApiToken).not.toHaveBeenCalled();
	});

	it('pages with after= or before=', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ messages: [] }));
		await fetchFestivalMessages('tmr26', { after: '1700000000001-aaaaaaaa' });
		expect(lastCall()[0].endsWith('/messages?after=1700000000001-aaaaaaaa')).toBe(true);
		fetchMock.mockClear();
		await fetchFestivalMessages('tmr26', { before: '1700000000002-bbbbbbbb' });
		expect(lastCall()[0].endsWith('/messages?before=1700000000002-bbbbbbbb')).toBe(true);
	});

	it('posts the text with a bearer token', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ message: {} }, 201));
		await postFestivalMessage('tmr26', 'hi');
		const [url, init] = lastCall();
		expect(url.endsWith('/festivals/tmr26/messages')).toBe(true);
		expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer clerk-jwt' } });
		expect(JSON.parse(init.body as string)).toEqual({ text: 'hi' });
	});

	it('deletes by encoded id with a bearer token', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
		await deleteFestivalMessage('tmr26', 'a/b');
		const [url, init] = lastCall();
		expect(url.endsWith('/messages/a%2Fb')).toBe(true);
		expect(init).toMatchObject({ method: 'DELETE', headers: { Authorization: 'Bearer clerk-jwt' } });
	});
});
