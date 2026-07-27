/**
 * @file Typed client for the StageHopper backend.
 *
 * Every call resolves to a discriminated result instead of throwing, so callers can
 * render a message without a try/catch around each fetch. `unauthorized` is broken
 * out because the caller must re-prompt for Google sign-in rather than just retry.
 */

import type { RoomMembership, RoomSelection, SelectionMap } from './types.js';

const API_BASE = '/api/stagehopper';

export type ApiResult<T> =
	| { ok: true; data: T }
	| { ok: false; unauthorized: boolean; status: number };

async function request<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
	try {
		const response = await fetch(url, init);
		if (!response.ok) {
			return { ok: false, unauthorized: response.status === 401, status: response.status };
		}
		return { ok: true, data: (await response.json()) as T };
	} catch {
		return { ok: false, unauthorized: false, status: 0 };
	}
}

function jsonRequest(method: string, body: unknown): RequestInit {
	return {
		method,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	};
}

/** Everyone's picks in a room. */
export function fetchRoomSelections(roomId: string): Promise<ApiResult<RoomSelection[]>> {
	return request(`${API_BASE}/rooms/${encodeURIComponent(roomId)}/selections`);
}

/** Write the viewer's picks, name and colour. Also records room membership server-side. */
export function putRoomSelections(
	roomId: string,
	payload: { googleIdToken: string; name: string; color: string; selections: SelectionMap }
): Promise<ApiResult<{ ok: boolean; participantKey: string; name: string }>> {
	return request(
		`${API_BASE}/rooms/${encodeURIComponent(roomId)}/selections`,
		jsonRequest('PUT', payload)
	);
}

/** Remove the viewer from a room, deleting their picks. */
export function leaveRoom(
	roomId: string,
	googleIdToken: string
): Promise<ApiResult<{ ok: boolean }>> {
	return request(
		`${API_BASE}/rooms/${encodeURIComponent(roomId)}/selections`,
		jsonRequest('DELETE', { googleIdToken })
	);
}

/** Register a new room id with the backend. */
export function createRoom(roomId: string): Promise<ApiResult<{ roomId: string }>> {
	return request(`${API_BASE}/rooms`, jsonRequest('POST', { roomId }));
}

/** Rooms the signed-in user has joined, most recently active first. */
export function listMyRooms(googleIdToken: string): Promise<ApiResult<RoomMembership[]>> {
	return request(`${API_BASE}/users/me/rooms`, jsonRequest('POST', { googleIdToken }));
}

/**
 * Whether the signed-in user may use the admin console.
 *
 * Unlike every other call here this collapses to a plain boolean, because there is no
 * useful way to render the difference: 403 is the server's ordinary answer for "signed
 * in, not an admin", and a 401, a 500 or a dead network all mean the same thing to the
 * caller — keep the admin UI hidden. It decides presentation only; the Lambda enforces.
 */
export async function checkAdmin(googleIdToken: string): Promise<boolean> {
	const result = await request<{ isAdmin?: boolean }>(
		`${API_BASE}/admin/me`,
		jsonRequest('POST', { googleIdToken })
	);
	return result.ok && result.data.isAdmin === true;
}
