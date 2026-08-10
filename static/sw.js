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

const CACHE_NAME = 'stagehopper-v1';
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

