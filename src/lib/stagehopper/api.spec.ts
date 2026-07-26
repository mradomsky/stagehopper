import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoom, fetchRoomSelections, leaveRoom, listMyRooms, putRoomSelections } from './api.js';

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
