/**
 * @file Typed client for the StageHopper backend.
 *
 * Every call resolves to a discriminated result instead of throwing, so callers can render
 * a message without a try/catch around each fetch. `unauthorized` is broken out because the
 * caller must re-prompt for sign-in rather than just retry.
 *
 * The credential travels in an `Authorization: Bearer` header and is minted per request by
 * {@link getApiToken}. Nothing here takes a token parameter: an API Gateway JWT authorizer
 * verifies the header before the Lambda is ever invoked, so a caller has no token to pass
 * and no identity to cache. That is also why the REST surface reads normally now — a body
 * is no longer the only place a credential could ride, so the reads are GETs.
 */

import { getApiToken } from './auth.svelte.js';
import type {
	AdminRoomSummary,
	AdminUserSummary,
	FestivalRecord,
	PageCursor,
	RoomMembership,
	RoomSelection,
	SelectionMap,
	TimetableImport,
	TimetableUpload
} from './types.js';

const API_BASE = '/api/stagehopper';

export type ApiResult<T> =
	| { ok: true; data: T }
	| { ok: false; unauthorized: boolean; status: number; error?: string };

/** Every failure body the Lambda sends is `{ error: string }`; best-effort, may be absent. */
async function readErrorMessage(response: Response): Promise<string | undefined> {
	try {
		const body = (await response.json()) as { error?: unknown };
		return typeof body.error === 'string' ? body.error : undefined;
	} catch {
		return undefined;
	}
}

async function request<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
	try {
		const response = await fetch(url, init);
		if (!response.ok) {
			return {
				ok: false,
				unauthorized: response.status === 401,
				status: response.status,
				error: await readErrorMessage(response)
			};
		}
		return { ok: true, data: (await response.json()) as T };
	} catch {
		return { ok: false, unauthorized: false, status: 0 };
	}
}

/**
 * A signed request.
 *
 * A fresh token per call, never a cached one: the tokens live 60 seconds and Clerk's SDK
 * owns the refresh, so asking each time is both correct and less code than tracking expiry.
 * No token means no session, which is the same thing to the caller as a 401 from the
 * gateway — so it is reported as one rather than as a distinct failure mode.
 */
async function authed<T>(url: string, method: string, body?: unknown): Promise<ApiResult<T>> {
	const token = await getApiToken();
	if (!token) return { ok: false, unauthorized: true, status: 401 };

	const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
	if (body !== undefined) headers['Content-Type'] = 'application/json';

	return request<T>(url, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body)
	});
}

/** Everyone's picks in a room — the one route with no authorizer, by design. Room ids are capability URLs. */
export function fetchRoomSelections(roomId: string): Promise<ApiResult<RoomSelection[]>> {
	return request(`${API_BASE}/rooms/${encodeURIComponent(roomId)}/selections`);
}

/** Write the viewer's picks, name and colour. Also records room membership server-side. */
export function putRoomSelections(
	roomId: string,
	payload: { name: string; color: string; selections: SelectionMap }
): Promise<ApiResult<{ ok: boolean; participantKey: string; name: string }>> {
	return authed(`${API_BASE}/rooms/${encodeURIComponent(roomId)}/selections`, 'PUT', payload);
}

/** Remove the viewer from a room, deleting their picks. */
export function leaveRoom(roomId: string): Promise<ApiResult<{ ok: boolean }>> {
	return authed(`${API_BASE}/rooms/${encodeURIComponent(roomId)}/selections`, 'DELETE');
}

/** Register a new room id with the backend. */
export function createRoom(roomId: string): Promise<ApiResult<{ roomId: string }>> {
	return authed(`${API_BASE}/rooms`, 'POST', { roomId });
}

/** Rooms the signed-in user has joined, most recently active first. */
export function listMyRooms(): Promise<ApiResult<RoomMembership[]>> {
	return authed(`${API_BASE}/users/me/rooms`, 'GET');
}

/**
 * Whether the signed-in user may use the admin console.
 *
 * Unlike every other call here this collapses to a plain boolean, because there is no
 * useful way to render the difference: 403 is the gateway's ordinary answer for "signed in,
 * not an admin", and a 401, a 500 or a dead network all mean the same thing to the caller —
 * keep the admin UI hidden. It decides presentation only; the gateway enforces.
 */
export async function checkAdmin(): Promise<boolean> {
	const result = await authed<{ isAdmin?: boolean }>(`${API_BASE}/admin/me`, 'GET');
	return result.ok && result.data.isAdmin === true;
}

/**
 * The full festival list, read through the API.
 *
 * The landing page reads the slim public manifest off CloudFront instead — it is public
 * and should stay cached. The editor uses this so it never renders a stale edge copy of a
 * record it is about to overwrite, and gets the full fields (`description`, etc.) the
 * manifest omits.
 */
export function fetchAdminFestivals(): Promise<ApiResult<{ festivals: FestivalRecord[] }>> {
	return authed(`${API_BASE}/admin/festivals`, 'GET');
}

/**
 * `published` is false when the write itself succeeded but republishing the public
 * `data/festivals/index.json` failed — the admin's change is saved, but visitors won't
 * see it until the next successful write to any festival republishes it.
 */
export interface PublishedFestivalResult {
	ok: boolean;
	festival: FestivalRecord;
	published: boolean;
}

/** Create a new festival. A 409 means its id is already taken. */
export function createFestival(
	festival: FestivalRecord
): Promise<ApiResult<PublishedFestivalResult>> {
	return authed(`${API_BASE}/admin/festivals`, 'POST', festival);
}

/** Update an existing festival. `id` is taken from the record but is not itself editable. */
export function updateFestival(
	festival: FestivalRecord
): Promise<ApiResult<PublishedFestivalResult>> {
	return authed(`${API_BASE}/admin/festivals/${encodeURIComponent(festival.id)}`, 'PATCH', festival);
}

/**
 * Delete a festival, its timetable, and its public artifacts. `published` is false when
 * the delete itself succeeded but removing/republishing one of the derived public
 * artifacts failed — see {@link PublishedFestivalResult}.
 */
export function deleteFestival(
	festivalId: string
): Promise<ApiResult<{ ok: boolean; published: boolean }>> {
	return authed(`${API_BASE}/admin/festivals/${encodeURIComponent(festivalId)}`, 'DELETE');
}

/**
 * Ask the Lambda to mint a presigned S3 PUT for a festival's cover image. The returned
 * `uploadUrl` is used directly with `fetch` — bytes go straight to S3, never through
 * this API — and `imageUrl` is the path to save on the festival record once that PUT
 * succeeds.
 */
export function presignFestivalImage(
	festivalId: string,
	contentType: string,
	contentLength: number
): Promise<ApiResult<{ uploadUrl: string; imageUrl: string }>> {
	return authed(
		`${API_BASE}/admin/festivals/${encodeURIComponent(festivalId)}/image-upload`,
		'POST',
		{ contentType, contentLength }
	);
}

/** PUT the bytes straight to S3 using a presigned URL from {@link presignFestivalImage}. */
export async function uploadToPresignedUrl(uploadUrl: string, blob: Blob): Promise<boolean> {
	try {
		const response = await fetch(uploadUrl, {
			method: 'PUT',
			headers: { 'Content-Type': blob.type },
			body: blob
		});
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Ask the Lambda to mint a presigned S3 PUT for a festival's map image. Mirrors
 * {@link presignFestivalImage} but for maps; bytes go straight to S3, never through
 * this API, and `mapUrl` is the path to save on the festival record once the PUT succeeds.
 */
export function presignFestivalMap(
	festivalId: string,
	contentType: string,
	contentLength: number
): Promise<ApiResult<{ uploadUrl: string; imageUrl: string }>> {
	return authed(`${API_BASE}/admin/festivals/${encodeURIComponent(festivalId)}/map-upload`, 'POST', {
		contentType,
		contentLength
	});
}

/**
 * Import a festival's timetable — write-once. A 409 means one already exists for this
 * festival; the caller can tell that apart from other failures via `result.status`.
 * `published` is false when the write succeeded but publishing the timetable failed.
 */
export function importFestivalTimetable(
	festivalId: string,
	timetable: TimetableUpload
): Promise<ApiResult<{ ok: boolean; published: boolean }>> {
	return authed(
		`${API_BASE}/admin/festivals/${encodeURIComponent(festivalId)}/timetable-import`,
		'POST',
		{ timetable }
	);
}

/** Fields a performance-card edit may change. `date` only matters when adding one. */
export interface TimetablePerformancePatch {
	date?: string;
	artist?: string;
	stage?: string;
	startTime?: string;
	endTime?: string;
	artistImage?: string;
	instagram?: string;
}

/**
 * Edit, add or delete one performance on a festival's timetable — a small patch, never
 * the whole file. `patch: null` deletes `performanceId`; a new `performanceId` with a
 * full patch (including `date`) adds one; an existing id with a partial patch updates
 * it in place. Concurrent edits to the same performance are last-write-wins, with no
 * conflict response — different performances are fully independent DynamoDB items.
 * `published` is false when the write succeeded but publishing the timetable failed;
 * `timetable` still reflects the current state either way.
 */
export function patchFestivalTimetable(
	festivalId: string,
	performanceId: string,
	patch: TimetablePerformancePatch | null
): Promise<ApiResult<{ ok: boolean; timetable: TimetableImport; published: boolean }>> {
	return authed(
		`${API_BASE}/admin/festivals/${encodeURIComponent(festivalId)}/timetable`,
		'PATCH',
		{ performanceId, patch }
	);
}

/**
 * One page of the room browser. There's no global room index in DynamoDB, so the backend
 * scans a bounded page of the users table and returns `nextKey` (null at the end); pass
 * it back as `startKey` for the next page. A room can straddle pages — the caller merges by id.
 */
export function listAdminRooms(
	startKey?: PageCursor | null
): Promise<ApiResult<{ rooms: AdminRoomSummary[]; nextKey: PageCursor | null }>> {
	return authed(`${API_BASE}/admin/rooms`, 'POST', { startKey });
}

/** One page of the user browser — same paged-scan contract as {@link listAdminRooms}. */
export function listAdminUsers(
	startKey?: PageCursor | null
): Promise<ApiResult<{ users: AdminUserSummary[]; nextKey: PageCursor | null }>> {
	return authed(`${API_BASE}/admin/users`, 'POST', { startKey });
}

/** Hard-delete a room and every participant's picks in it. `deleted` is the participant count. */
export function deleteAdminRoom(
	roomId: string
): Promise<ApiResult<{ ok: boolean; deleted: number }>> {
	return authed(`${API_BASE}/admin/rooms/${encodeURIComponent(roomId)}`, 'DELETE');
}

/** Hard-delete a user, their memberships, and their picks across every room they joined. */
export function deleteAdminUser(
	userId: string
): Promise<ApiResult<{ ok: boolean; deleted: number }>> {
	return authed(`${API_BASE}/admin/users/${encodeURIComponent(userId)}`, 'DELETE');
}

/**
 * Send a test push to one user's devices, on demand. `sent`/`total` count devices reached.
 * A user with no subscriptions (or whose every device rejected) comes back as a non-ok
 * result with an error message, not a thrown request.
 */
export function sendTestNotification(
	userId: string
): Promise<ApiResult<{ ok: boolean; sent: number; total: number }>> {
	return authed(
		`${API_BASE}/admin/users/${encodeURIComponent(userId)}/test-notification`,
		'POST'
	);
}

/** Push notification settings for the signed-in user. */
export interface NotificationSettings {
	leadMinutes: number;
	/** Whether "maybe" marks notify. "Going" marks always notify — there's no toggle for it. */
	notifyMaybe: boolean;
	/** Per-performance overrides of the default notify rule, keyed by performance id. */
	notifyOverrides: Record<string, boolean>;
	enabled: boolean;
	subscribedHere: boolean;
}

/**
 * Fetch the signed-in user's push notification settings, optionally for a specific
 * subscription endpoint.
 *
 * Still a POST, unlike the other reads: the endpoint is a long opaque push-service URL, and
 * a query string is the wrong place for it.
 */
export function getNotificationSettings(
	endpoint?: string
): Promise<ApiResult<NotificationSettings>> {
	return authed(`${API_BASE}/users/me/notifications`, 'POST', { endpoint });
}

/** The preference fields the user controls — what the PUT accepts and echoes back. */
export type NotificationPreferences = Pick<NotificationSettings, 'leadMinutes' | 'notifyMaybe'>;

/**
 * Update the signed-in user's push notification settings. The PUT echoes back only the
 * preference fields — `enabled`/`subscribedHere` are subscription-derived, not written here.
 */
export function saveNotificationSettings(
	settings: NotificationPreferences
): Promise<ApiResult<NotificationPreferences>> {
	return authed(`${API_BASE}/users/me/notifications`, 'PUT', settings);
}

/**
 * Set or clear one performance's notification override — the bell in the Picks list.
 * `value: null` removes the override, reverting that performance to the default rule
 * (see {@link import('./picks.js').effectiveNotify}).
 */
export function saveNotificationOverride(
	performanceId: string,
	value: boolean | null
): Promise<ApiResult<{ ok: boolean }>> {
	return authed(`${API_BASE}/users/me/notifications`, 'PUT', {
		notifyOverrides: { [performanceId]: value }
	});
}

/** Push subscription keys as delivered by the browser. */
export interface PushSubscriptionKeys {
	p256dh: string;
	auth: string;
}

/** A browser push subscription to register server-side. */
export interface PushSubscription {
	endpoint: string;
	keys: PushSubscriptionKeys;
}

/** Register a new push subscription for the signed-in user. */
export function addPushSubscription(
	subscription: PushSubscription
): Promise<ApiResult<{ ok: boolean }>> {
	return authed(`${API_BASE}/users/me/notifications/subscription`, 'POST', { subscription });
}

/** Remove a push subscription from the signed-in user's account. */
export function removePushSubscription(endpoint: string): Promise<ApiResult<{ ok: boolean }>> {
	return authed(`${API_BASE}/users/me/notifications/subscription`, 'DELETE', { endpoint });
}
