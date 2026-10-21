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

import { apiBase } from './config.js';
import { getApiToken } from './auth.svelte.js';
import type {
	AdminUserSummary,
	FestivalRecord,
	FestivalSummary,
	PageCursor,
	SelectionMap,
	TimetableImport,
	TimetableUpload
} from './types.js';

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

/**
 * Public summary of one Festival for its landing card: Attendee count and the latest
 * Message. Signed-out visitors read it, so it goes through the unauthenticated `request()`
 * with no Authorization header. The body is validated because an unwired route answers
 * `200 text/html` (CLAUDE.md trap 1) and CloudFront can serve JSON that is not ours; any
 * wrong shape is reported as a failure so the card renders without it.
 */
export async function fetchFestivalSummary(
	festivalId: string
): Promise<ApiResult<FestivalSummary>> {
	const result = await request<unknown>(
		`${apiBase()}/festivals/${encodeURIComponent(festivalId)}/summary`
	);
	if (!result.ok) return result;
	return isFestivalSummary(result.data)
		? { ok: true, data: result.data }
		: { ok: false, unauthorized: false, status: 200 };
}

function isFestivalSummary(value: unknown): value is FestivalSummary {
	if (typeof value !== 'object' || value === null) return false;
	const { attendees, latestMessage } = value as Record<string, unknown>;
	if (typeof attendees !== 'number' || !Number.isInteger(attendees) || attendees < 0) return false;
	if (latestMessage === null) return true;
	if (typeof latestMessage !== 'object' || latestMessage === undefined) return false;
	const { handle, text } = latestMessage as Record<string, unknown>;
	return typeof handle === 'string' && typeof text === 'string';
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
	const result = await authed<{ isAdmin?: boolean }>(`${apiBase()}/admin/me`, 'GET');
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
	return authed(`${apiBase()}/admin/festivals`, 'GET');
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
	return authed(`${apiBase()}/admin/festivals`, 'POST', festival);
}

/** Update an existing festival. `id` is taken from the record but is not itself editable. */
export function updateFestival(
	festival: FestivalRecord
): Promise<ApiResult<PublishedFestivalResult>> {
	return authed(`${apiBase()}/admin/festivals/${encodeURIComponent(festival.id)}`, 'PATCH', festival);
}

/**
 * Save a festival's manual stage display order. A dedicated endpoint rather than
 * {@link updateFestival}: the drag-to-reorder UI saves on every drop, and resending the
 * whole record that often risks clobbering a concurrent edit to some other field.
 */
export function updateFestivalStageOrder(
	festivalId: string,
	stageOrder: string[]
): Promise<ApiResult<{ ok: boolean; stageOrder: string[]; published: boolean }>> {
	return authed(
		`${apiBase()}/admin/festivals/${encodeURIComponent(festivalId)}/stage-order`,
		'PATCH',
		{ stageOrder }
	);
}

/**
 * Delete a festival, its timetable, and its public artifacts. `published` is false when
 * the delete itself succeeded but removing/republishing one of the derived public
 * artifacts failed — see {@link PublishedFestivalResult}.
 */
export function deleteFestival(
	festivalId: string
): Promise<ApiResult<{ ok: boolean; published: boolean }>> {
	return authed(`${apiBase()}/admin/festivals/${encodeURIComponent(festivalId)}`, 'DELETE');
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
		`${apiBase()}/admin/festivals/${encodeURIComponent(festivalId)}/image-upload`,
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
	return authed(`${apiBase()}/admin/festivals/${encodeURIComponent(festivalId)}/map-upload`, 'POST', {
		contentType,
		contentLength
	});
}

/**
 * Import a festival's timetable.
 *
 * Write-once unless `replace` is set: without it, a festival that already has a timetable
 * answers 409, so a double-submitted form cannot wipe one. `replace` opts into rewriting
 * it, which re-keys every performance and therefore orphans every Pick, so the backend
 * refuses it outright while the festival has Picks, with a 409 of its own. Both cases
 * arrive as `result.status === 409`; `result.error` is what distinguishes them.
 *
 * `published` is false when the write succeeded but publishing the timetable failed, and
 * `replaced` is how many performances the import deleted to make space for its own.
 */
export function importFestivalTimetable(
	festivalId: string,
	timetable: TimetableUpload,
	replace = false
): Promise<ApiResult<{ ok: boolean; published: boolean; replaced: number }>> {
	return authed(
		`${apiBase()}/admin/festivals/${encodeURIComponent(festivalId)}/timetable-import`,
		'POST',
		{ timetable, ...(replace ? { replace: true } : {}) }
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
	spotify?: string;
	youtube?: string;
	soundcloud?: string;
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
		`${apiBase()}/admin/festivals/${encodeURIComponent(festivalId)}/timetable`,
		'PATCH',
		{ performanceId, patch }
	);
}

/** One page of the user browser: a bounded page of the users table, with `nextKey` (null at the end) to pass back as `startKey`. */
export function listAdminUsers(
	startKey?: PageCursor | null
): Promise<ApiResult<{ users: AdminUserSummary[]; nextKey: PageCursor | null }>> {
	return authed(`${apiBase()}/admin/users`, 'POST', { startKey });
}

/** Hard-delete a user with their Picks, Messages and push subscriptions. */
export function deleteAdminUser(
	userId: string
): Promise<ApiResult<{ ok: boolean }>> {
	return authed(`${apiBase()}/admin/users/${encodeURIComponent(userId)}`, 'DELETE');
}

/** Ban a user: they can no longer Pick or post Messages. `banned` echoes the new state. */
export function banAdminUser(
	userId: string
): Promise<ApiResult<{ ok: boolean; userId: string; banned: boolean }>> {
	return authed(`${apiBase()}/admin/users/${encodeURIComponent(userId)}/ban`, 'POST');
}

/** Lift a ban. Same response shape as {@link banAdminUser}. */
export function unbanAdminUser(
	userId: string
): Promise<ApiResult<{ ok: boolean; userId: string; banned: boolean }>> {
	return authed(`${apiBase()}/admin/users/${encodeURIComponent(userId)}/ban`, 'DELETE');
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
		`${apiBase()}/admin/users/${encodeURIComponent(userId)}/test-notification`,
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
	return authed(`${apiBase()}/users/me/notifications`, 'POST', { endpoint });
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
	return authed(`${apiBase()}/users/me/notifications`, 'PUT', settings);
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
	return authed(`${apiBase()}/users/me/notifications`, 'PUT', {
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
	return authed(`${apiBase()}/users/me/notifications/subscription`, 'POST', { subscription });
}

/** Remove a push subscription from the signed-in user's account. */
export function removePushSubscription(endpoint: string): Promise<ApiResult<{ ok: boolean }>> {
	return authed(`${apiBase()}/users/me/notifications/subscription`, 'DELETE', { endpoint });
}

// ---- Festival Picks and Attendee profile ----

/** One Attendee's public Pick on a Performance. The public read carries no user id. */
export interface FestivalPickRow {
	handle: string;
	colour: string;
	/** 1 = going, 2 = maybe. */
	state: number;
}

/** Everyone's Picks for a Festival, grouped by Performance id. No authorizer, by design. */
export function fetchFestivalPicks(
	festivalId: string
): Promise<ApiResult<Record<string, FestivalPickRow[]>>> {
	return request(`${apiBase()}/festivals/${encodeURIComponent(festivalId)}/picks`);
}

/** The signed-in user's own pick map for a Festival: the base a whole-map save must start from. */
export function fetchMyFestivalPicks(
	festivalId: string
): Promise<ApiResult<{ selections: SelectionMap }>> {
	return authed(`${apiBase()}/festivals/${encodeURIComponent(festivalId)}/picks/me`, 'GET');
}

/**
 * Replace the signed-in user's whole pick map for a Festival. An empty map deletes the row,
 * so callers must never send one built before {@link fetchMyFestivalPicks} has answered.
 */
export function putFestivalPicks(
	festivalId: string,
	selections: SelectionMap
): Promise<ApiResult<{ ok: boolean }>> {
	return authed(`${apiBase()}/festivals/${encodeURIComponent(festivalId)}/picks`, 'PUT', {
		selections
	});
}

/** The signed-in Attendee: Handle is read-only (from Clerk), Colour is null until chosen. */
export interface AttendeeProfile {
	handle: string;
	colour: string | null;
}

export function fetchProfile(): Promise<ApiResult<AttendeeProfile>> {
	return authed(`${apiBase()}/users/me/profile`, 'GET');
}

export function putProfileColour(colour: string): Promise<ApiResult<AttendeeProfile>> {
	return authed(`${apiBase()}/users/me/profile`, 'PUT', { colour });
}

// ---- Festival chat ----

/** One chat Message as the API publishes it. Ids sort by time as strings. */
export interface ChatMessage {
	messageId: string;
	handle: string;
	colour: string;
	text: string;
	createdAt: number;
}

/** A page of Messages, oldest first. `after` pages forward from a cursor, `before` backwards. */
export function fetchFestivalMessages(
	festivalId: string,
	cursor: { after?: string; before?: string } = {}
): Promise<ApiResult<{ messages: ChatMessage[] }>> {
	const query = cursor.after
		? `?after=${encodeURIComponent(cursor.after)}`
		: cursor.before
			? `?before=${encodeURIComponent(cursor.before)}`
			: '';
	return request(`${apiBase()}/festivals/${encodeURIComponent(festivalId)}/messages${query}`);
}

export function postFestivalMessage(
	festivalId: string,
	text: string
): Promise<ApiResult<{ message: ChatMessage }>> {
	return authed(`${apiBase()}/festivals/${encodeURIComponent(festivalId)}/messages`, 'POST', {
		text
	});
}

export function deleteFestivalMessage(
	festivalId: string,
	messageId: string
): Promise<ApiResult<{ ok: boolean }>> {
	return authed(
		`${apiBase()}/festivals/${encodeURIComponent(festivalId)}/messages/${encodeURIComponent(messageId)}`,
		'DELETE'
	);
}
