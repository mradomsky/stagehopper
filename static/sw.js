/**
 * StageHopper Service Worker
 *
 * Strategy:
 * - Static assets (_app/**): Cache-first (immutable, content-hashed)
 * - HTML pages: Network-first with fallback to cache
 * - /api/*: Network-only (never cache API responses)
 * - /data/* (festivals.json, timetable-{id}.json): Cache-first with a background
 *   revalidation — these aren't content-hashed like _app assets, so a network-first
 *   strategy would stall the grid on bad festival signal, but a pure cache-first would
 *   pin an admin's edit forever. This serves the cached copy immediately (if any) and
 *   refetches in the background, so the *next* load picks up the change.
 */

const CACHE_NAME = 'stagehopper-v3';
const MAP_CACHE = 'stagehopper-maps-v1';
const MAP_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAP_META_KEY = '__map-meta__';

// ---- Install ----

// Nothing is pre-cached: the app shell is fetched on first navigation and cached
// by the fetch handler below, so installing stays instant.
self.addEventListener('install', () => {
	self.skipWaiting();
});

// ---- Activate ----

self.addEventListener('activate', (event) => {
	// Logs which worker won on this device — the first thing to check when debugging a
	// stale-worker problem. Bump CACHE_NAME on any push-handler change and this line tells
	// you at a glance whether the device actually picked up the new build.
	console.log(`[sw] activated (${CACHE_NAME})`);
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys
						.filter((k) => k !== CACHE_NAME && k !== MAP_CACHE)
						.map((k) => caches.delete(k))
				),
			)
			.then(() => pruneMaps())
			.then(() => self.clients.claim()),
	);
});

/**
 * Remove expired map entries from the map cache based on their timestamps in the metadata.
 */
async function pruneMaps() {
	const cache = await caches.open(MAP_CACHE);
	const metaReq = new Request(`https://localhost/${MAP_META_KEY}`);
	const metaResp = await cache.match(metaReq);
	if (!metaResp) return;

	try {
		const meta = await metaResp.json();
		const now = Date.now();
		const expired = [];

		for (const [url, timestamp] of Object.entries(meta)) {
			if (typeof timestamp !== 'number' || now - timestamp > MAP_TTL_MS) {
				expired.push(url);
			}
		}

		// Delete expired entries and update metadata.
		await Promise.all(expired.map((url) => cache.delete(url)));
		if (expired.length > 0) {
			const updated = { ...meta };
			expired.forEach((url) => delete updated[url]);
			const newMeta = new Response(JSON.stringify(updated), {
				headers: { 'Content-Type': 'application/json' }
			});
			await cache.put(metaReq, newMeta);
		}
	} catch {
		// Metadata corrupted or missing — just continue.
	}
}

// ---- Fetch ----

self.addEventListener('fetch', (event) => {
	const { request } = event;
	const url = new URL(request.url);

	// Skip non-GET requests
	if (request.method !== 'GET') return;

	// Skip API calls — always go to network
	if (url.pathname.startsWith('/api/')) return;

	// Skip cross-origin requests
	if (url.origin !== self.location.origin) return;

	// Festival maps: cache-first with 30-day TTL. Store timestamps in metadata to track age.
	if (url.pathname.startsWith('/data/festival-maps/')) {
		event.respondWith(
			caches.open(MAP_CACHE).then(async (cache) => {
				const cached = await cache.match(request);
				const metaReq = new Request(`https://localhost/${MAP_META_KEY}`);
				const metaResp = await cache.match(metaReq);
				let meta = {};
				if (metaResp) {
					try {
						meta = await metaResp.json();
					} catch {
						meta = {};
					}
				}

				const cachedTs = meta[request.url];
				const now = Date.now();
				const isExpired = !cachedTs || now - cachedTs > MAP_TTL_MS;

				// If cached and not expired, return it immediately.
				if (cached && !isExpired) {
					return cached;
				}

				// Otherwise, try to fetch fresh.
				try {
					const resp = await fetch(request);
					if (resp.ok) {
						// Store the fresh copy and update timestamp.
						await cache.put(request, resp.clone());
						meta[request.url] = now;
						const newMeta = new Response(JSON.stringify(meta), {
							headers: { 'Content-Type': 'application/json' }
						});
						await cache.put(metaReq, newMeta);
						return resp;
					}
					return cached || Response.error();
				} catch {
					return cached || Response.error();
				}
			}),
		);
		return;
	}

	// Admin-editable data (festivals.json, timetables): cache-first, revalidated in the
	// background so an edit shows up on the visit after this one, not never.
	if (url.pathname.startsWith('/data/')) {
		event.respondWith(
			caches.open(CACHE_NAME).then(async (cache) => {
				const cached = await cache.match(request);
				const network = fetch(request)
					.then((resp) => {
						if (resp.ok) cache.put(request, resp.clone());
						return resp;
					})
					.catch(() => null);
				// Keeps the worker alive until the background revalidation settles —
				// without this, a cache hit returns immediately below and the browser is
				// free to kill the worker before cache.put() ever runs.
				event.waitUntil(network);
				return cached || (await network) || Response.error();
			}),
		);
		return;
	}

	// Immutable static assets (_app/immutable/**): cache-first forever
	if (url.pathname.startsWith('/_app/immutable/')) {
		event.respondWith(
			caches.open(CACHE_NAME).then((cache) =>
				cache.match(request).then(
					(cached) =>
						cached ||
						fetch(request).then((resp) => {
							if (resp.ok) cache.put(request, resp.clone());
							return resp;
						}),
				),
			),
		);
		return;
	}

	// HTML pages and other assets: network-first, fallback to cache
	event.respondWith(
		fetch(request)
			.then((resp) => {
				if (resp.ok) {
					const clone = resp.clone();
					caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
				}
				return resp;
			})
			.catch(() => caches.match(request).then((cached) => cached || caches.match('/index.html'))),
	);
});


// ---- Push notifications ----

// Every push-path log carries this prefix so it's greppable in DevTools / Safari Web
// Inspector when a notification doesn't show. Reaching this file at all means the device
// is running a worker new enough to have the push handler — a stale worker (the failure
// this feature has hit repeatedly) simply prints nothing.
const LOG = '[sw:push]';

// A push carries a JSON payload built by the notifier Lambda
// ({ performanceId, roomId, artist, stage, startTime }). Show it as a notification;
// the tag collapses any accidental re-fire for the same performance.
self.addEventListener('push', (event) => {
	// The two early returns below are silent failure modes that made this hard to debug:
	// a push received with no body, or a body that isn't the JSON we expect. Log both so a
	// delivered-but-not-shown notification leaves a trace instead of vanishing.
	if (!event.data) {
		console.warn(`${LOG} received a push with no data — nothing to show`);
		return;
	}
	let payload;
	try {
		payload = event.data.json();
	} catch (err) {
		console.warn(`${LOG} push data was not valid JSON:`, err, '· raw:', safeText(event.data));
		return;
	}
	console.log(`${LOG} received`, payload);
	const title = payload.artist || 'StageHopper';
	const body = payload.startTime
		? `${payload.stage || ''} · starts ${payload.startTime}`.replace(/^ · /, '')
		: payload.stage || '';
	event.waitUntil(
		self.registration
			.showNotification(title, {
				body,
				tag: payload.performanceId,
				data: payload,
			})
			.then(() => console.log(`${LOG} showNotification resolved for`, payload.performanceId))
			// A rejection here means the push arrived and was decrypted but the OS refused to
			// display it (e.g. permission revoked at the system level) — the one failure the
			// server can never see.
			.catch((err) => console.error(`${LOG} showNotification failed:`, err)),
	);
});

/** Best-effort plain-text of a push body, for logging a malformed payload without throwing. */
function safeText(data) {
	try {
		return data.text();
	} catch {
		return '<unreadable>';
	}
}

// Tapping opens the room, anchored to the performance (see issue #69). Focus an already
// open window if there is one, otherwise open a fresh one.
self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const data = event.notification.data || {};
	console.log(`${LOG} notification clicked`, data);
	const target = data.roomId
		? `/room/${data.roomId}${data.performanceId ? `#perf-${data.performanceId}` : ''}`
		: '/';
	event.waitUntil(
		self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
			for (const client of clients) {
				if ('focus' in client) {
					if ('navigate' in client) {
						try {
							client.navigate(target);
						} catch {
							// Cross-origin or detached client — fall back to focus alone.
						}
					}
					return client.focus();
				}
			}
			return self.clients.openWindow(target);
		}),
	);
});
