/**
 * StageHopper Service Worker
 *
 * Strategy:
 * - Static assets (_app/**): Cache-first (immutable, content-hashed)
 * - HTML pages: Network-first with fallback to cache
 * - /api/*: Network-only (never cache API responses)
 * - timetable.json: Cache-first (static data, bundled with app)
 */

const CACHE_NAME = 'stagehopper-v1';

/** Immutable app shell assets to pre-cache on install */
const PRECACHE_URLS = ['/', '/index.html'];

// ---- Install ----

self.addEventListener('install', (event) => {
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

