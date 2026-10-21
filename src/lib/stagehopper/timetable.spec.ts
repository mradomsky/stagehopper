import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	buildStageOrder,
	fetchTimetableForFestival,
	formatDateLabel,
	groupPerformancesByStage,
	orderStagesByFavourite,
	resolveStageOrder,
	timetableDataPath,
	toDisplayTimetable
} from './timetable.js';
import {
	DEFAULT_FESTIVALS,
	FESTIVALS,
	FESTIVAL_DATA_PATH,
	normalizeFestival
} from './festivals.svelte.js';
import type { Timetable, TimetableImportDay } from './types.js';

function jsonResponse(body: unknown, status = 200) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('timetableDataPath', () => {
	it('points at the per-festival S3 path', () => {
		expect(timetableDataPath('tmr26')).toBe('/data/festivals/tmr26/timetable.json');
	});
});

describe('formatDateLabel', () => {
	it('labels a date regardless of the viewer timezone', () => {
		expect(formatDateLabel('2026-07-17')).toBe('Friday, July 17');
	});
});

describe('toDisplayTimetable', () => {
	it('derives the label for each day; the source has none', () => {
		const days: TimetableImportDay[] = [
			{ date: '2026-07-17', performances: [] },
			{ date: '2026-07-18', performances: [] }
		];

		const timetable = toDisplayTimetable('Test Fest', days);

		expect(timetable.festival).toBe('Test Fest');
		expect(timetable.days.map((d) => d.label)).toEqual(['Friday, July 17', 'Saturday, July 18']);
	});

	it('carries performances through unchanged', () => {
		const days: TimetableImportDay[] = [
			{
				date: '2026-07-17',
				performances: [{ id: 'a', artist: 'A', stage: 'MAIN', startTime: '14:00', endTime: '15:00' }]
			}
		];

		expect(toDisplayTimetable('F', days).days[0]?.performances).toEqual(days[0]?.performances);
	});
});

describe('fetchTimetableForFestival', () => {
	const DAYS: TimetableImportDay[] = [
		{
			date: '2026-07-17',
			performances: [{ id: 'a', artist: 'A', stage: 'MAIN', startTime: '14:00', endTime: '15:00' }]
		}
	];

	it('fetches the given festival id directly, with no fallback to another festival', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ days: DAYS }));

		const result = await fetchTimetableForFestival('tmr26', 'Tomorrowland', fetchMock);

		expect(fetchMock).toHaveBeenCalledWith('/data/festivals/tmr26/timetable.json');
		expect(result).toEqual({
			ok: true,
			data: { festival: 'Tomorrowland', days: expect.any(Array) },
			festivalId: 'tmr26'
		});
	});

	it('reports failure on a non-ok response', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 404));

		expect(await fetchTimetableForFestival('tmr26', 'Tomorrowland', fetchMock)).toEqual({ ok: false });
	});
});

describe('buildStageOrder', () => {
	it('orders stages by first appearance across the whole festival', () => {
		const timetable: Timetable = {
			festival: 'F',
			days: [
				{
					date: '1',
					label: '1',
					performances: [
						{ id: 'a', artist: 'A', stage: 'B STAGE', startTime: '14:00', endTime: '15:00' },
						{ id: 'b', artist: 'B', stage: 'A STAGE', startTime: '14:00', endTime: '15:00' }
					]
				},
				{
					date: '2',
					label: '2',
					performances: [
						{ id: 'c', artist: 'C', stage: 'C STAGE', startTime: '14:00', endTime: '15:00' },
						{ id: 'd', artist: 'D', stage: 'A STAGE', startTime: '14:00', endTime: '15:00' }
					]
				}
			]
		};

		expect(buildStageOrder(timetable)).toEqual(['B STAGE', 'A STAGE', 'C STAGE']);
	});
});

describe('resolveStageOrder', () => {
	const timetable: Timetable = {
		festival: 'F',
		days: [
			{
				date: '1',
				label: '1',
				performances: [
					{ id: 'a', artist: 'A', stage: 'B STAGE', startTime: '14:00', endTime: '15:00' },
					{ id: 'b', artist: 'B', stage: 'A STAGE', startTime: '14:00', endTime: '15:00' },
					{ id: 'c', artist: 'C', stage: 'C STAGE', startTime: '14:00', endTime: '15:00' }
				]
			}
		]
	};

	it('falls back to first-appearance order when no stageOrder is set', () => {
		expect(resolveStageOrder(timetable)).toEqual(['B STAGE', 'A STAGE', 'C STAGE']);
		expect(resolveStageOrder(timetable, [])).toEqual(['B STAGE', 'A STAGE', 'C STAGE']);
	});

	it('uses the admin order for stages it names', () => {
		expect(resolveStageOrder(timetable, ['A STAGE', 'C STAGE', 'B STAGE'])).toEqual([
			'A STAGE',
			'C STAGE',
			'B STAGE'
		]);
	});

	it('appends stages missing from stageOrder, in first-appearance order', () => {
		expect(resolveStageOrder(timetable, ['C STAGE'])).toEqual(['C STAGE', 'B STAGE', 'A STAGE']);
	});

	it('drops stageOrder entries no longer present in the timetable', () => {
		expect(resolveStageOrder(timetable, ['GONE STAGE', 'C STAGE', 'A STAGE'])).toEqual([
			'C STAGE',
			'A STAGE',
			'B STAGE'
		]);
	});
});

describe('orderStagesByFavourite', () => {
	const order = ['A', 'B', 'C', 'D'];

	it('returns the order unchanged when there are no favourites', () => {
		expect(orderStagesByFavourite(order, new Set())).toEqual(order);
	});

	it('floats favourites to the front, each group keeping its original order', () => {
		expect(orderStagesByFavourite(order, new Set(['C', 'A']))).toEqual(['A', 'C', 'B', 'D']);
	});

	it('ignores favourite names not present in the timetable', () => {
		expect(orderStagesByFavourite(order, new Set(['C', 'ZZZ']))).toEqual(['C', 'A', 'B', 'D']);
	});
});

describe('groupPerformancesByStage', () => {
	const day = {
		date: '1',
		label: '1',
		performances: [
			{ id: 'a', artist: 'A', stage: 'MAIN', startTime: '14:00', endTime: '15:00' },
			{ id: 'b', artist: 'B', stage: 'MAIN', startTime: '15:00', endTime: '16:00' }
		]
	};

	it('groups performances into their stage columns', () => {
		const stages = groupPerformancesByStage(day, ['MAIN']);
		expect(stages).toHaveLength(1);
		expect(stages[0]?.performances.map((p) => p.id)).toEqual(['a', 'b']);
	});

	it('drops stages with nothing on that day', () => {
		expect(groupPerformancesByStage(day, ['MAIN', 'EMPTY']).map((s) => s.name)).toEqual(['MAIN']);
	});

	it('returns nothing when there is no day', () => {
		expect(groupPerformancesByStage(undefined, ['MAIN'])).toEqual([]);
	});
});
