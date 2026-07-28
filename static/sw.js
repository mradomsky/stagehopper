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
				Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
			)
			.then(() => self.clients.claim()),
	);
});

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

