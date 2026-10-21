import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth.svelte.js', () => ({ getApiToken: async () => 'clerk-jwt' }));

const { configure, resetConfig, STORAGE_PREFIX } = await import('./config.js');
const { fetchFestivalSummary } = await import('./api.js');
const { loadFestivals } = await import('./festivals.svelte.js');
const { fetchTimetableForFestival } = await import('./timetable.js');

function jsonResponse(body: unknown, status = 200) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

afterEach(() => {
	resetConfig();
	vi.unstubAllGlobals();
});

async function urls() {
	const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
	vi.stubGlobal('fetch', fetchMock);
	await fetchFestivalSummary('tmr26');
	await loadFestivals(fetchMock);
	await fetchTimetableForFestival('tmr26', 'TMR', fetchMock);
	return fetchMock.mock.calls.map((c) => c[0]);
}

describe('runtime config', () => {
	it('keeps today\'s relative URLs when never configured', async () => {
		expect(await urls()).toEqual([
			'/api/stagehopper/festivals/tmr26/summary',
			'/data/festivals/index.json',
			'/data/festivals/tmr26/timetable.json'
		]);
	});

	it('reads bases at call time, after modules were imported', async () => {
		configure({ apiBase: 'https://app.example/api/stagehopper', dataBase: 'https://app.example/data' });
		expect(await urls()).toEqual([
			'https://app.example/api/stagehopper/festivals/tmr26/summary',
			'https://app.example/data/festivals/index.json',
			'https://app.example/data/festivals/tmr26/timetable.json'
		]);
	});

	it('leaves the other base at its default on a partial configure', async () => {
		configure({ dataBase: 'https://cdn.example/data' });
		expect(await urls()).toEqual([
			'/api/stagehopper/festivals/tmr26/summary',
			'https://cdn.example/data/festivals/index.json',
			'https://cdn.example/data/festivals/tmr26/timetable.json'
		]);
	});

	it('exposes the storage prefix unchanged', () => {
		expect(STORAGE_PREFIX).toBe('stagehopper');
	});
});
