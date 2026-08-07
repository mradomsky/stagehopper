import { describe, expect, it, vi } from 'vitest';
import {
	buildStageOrder,
	collectLikedPerformances,
	fetchTimetableForFestival,
	fetchTimetableForRoom,
	formatDateLabel,
	groupPerformancesByStage,
	timetableDataPath,
	toDisplayTimetable
} from './timetable.js';
import type { Timetable, TimetableImportDay } from './types.js';

function jsonResponse(body: unknown, status = 200) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('timetableDataPath', () => {
	it('points at the per-festival S3 path', () => {
		expect(timetableDataPath('tmr26')).toBe('/data/timetable-tmr26.json');
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

describe('fetchTimetableForRoom', () => {
	const DAYS: TimetableImportDay[] = [
		{
			date: '2026-07-17',
			performances: [{ id: 'a', artist: 'A', stage: 'MAIN', startTime: '14:00', endTime: '15:00' }]
		}
	];

	it('fetches the festival-prefixed room id at its data path', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ days: DAYS }));

		const result = await fetchTimetableForRoom('tmr26-abc123', fetchMock);

		expect(fetchMock).toHaveBeenCalledWith('/data/timetable-tmr26.json');
		expect(result).toEqual({ ok: true, data: expect.objectContaining({ days: expect.any(Array) }) });
	});

	it('resolves the same path for the bare festival browse id', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ days: DAYS }));

		await fetchTimetableForRoom('tmr26', fetchMock);

		expect(fetchMock).toHaveBeenCalledWith('/data/timetable-tmr26.json');
	});

	it('falls back to the latest festival for a custom room name', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ days: DAYS }));

		const result = await fetchTimetableForRoom('birthday-party', fetchMock);

		expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/data\/timetable-/));
		expect(result.ok).toBe(true);
	});

	it('reports failure on a non-ok response', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 404));

		expect(await fetchTimetableForRoom('tmr26', fetchMock)).toEqual({ ok: false });
	});

	it('reports failure when the network throws', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'));

		expect(await fetchTimetableForRoom('tmr26', fetchMock)).toEqual({ ok: false });
	});

	it('reports failure on malformed JSON', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => {
				throw new SyntaxError('bad json');
			}
		});

		expect(await fetchTimetableForRoom('tmr26', fetchMock)).toEqual({ ok: false });
	});

	it('reports failure when the payload has no days array', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ formatVersion: 1 }));

		expect(await fetchTimetableForRoom('tmr26', fetchMock)).toEqual({ ok: false });
	});
});

describe('fetchTimetableForFestival', () => {
	const DAYS: TimetableImportDay[] = [
		{
			date: '2026-07-17',
			performances: [{ id: 'a', artist: 'A', stage: 'MAIN', startTime: '14:00', endTime: '15:00' }]
		}
	];

	it('fetches the given festival id directly, with no room resolution', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ days: DAYS }));

		const result = await fetchTimetableForFestival('tmr26', 'Tomorrowland', fetchMock);

		expect(fetchMock).toHaveBeenCalledWith('/data/timetable-tmr26.json');
		expect(result).toEqual({ ok: true, data: { festival: 'Tomorrowland', days: expect.any(Array) } });
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

describe('collectLikedPerformances', () => {
	const timetable: Timetable = {
		festival: 'F',
		days: [
			{
				date: '2026-07-18',
				label: 'Saturday',
				performances: [
					{ id: 'later', artist: 'Later', stage: 'MAIN', startTime: '20:00', endTime: '21:00' }
				]
			},
			{
				date: '2026-07-17',
				label: 'Friday',
				performances: [
					{ id: 'early', artist: 'Early', stage: 'MAIN', startTime: '14:00', endTime: '15:00' },
					{ id: 'skipped', artist: 'Skipped', stage: 'MAIN', startTime: '16:00', endTime: '17:00' }
				]
			}
		]
	};

	it('returns liked performances in chronological order with their day label', () => {
		const liked = collectLikedPerformances(timetable, new Set(['later', 'early']));
		expect(liked.map((p) => p.id)).toEqual(['early', 'later']);
		expect(liked[0]?.dayLabel).toBe('Friday');
	});

	it('returns nothing when nothing is liked', () => {
		expect(collectLikedPerformances(timetable, new Set())).toEqual([]);
	});
});
