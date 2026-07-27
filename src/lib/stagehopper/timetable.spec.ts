import { describe, expect, it } from 'vitest';
import primaryTimetable from './timetable.json';
import {
	buildStageOrder,
	collectLikedPerformances,
	getTimetableForRoom,
	groupPerformancesByStage,
	normalizeTimetable
} from './timetable.js';
import type { Timetable } from './types.js';

describe('normalizeTimetable', () => {
	it('groups the Tomorrowland feed into sorted days', () => {
		const normalized = normalizeTimetable(
			{
				festival: 'Tomorrowland',
				performances: [
					{
						id: '2',
						name: 'Second',
						stage: { name: 'MAIN' },
						date: '2026-07-18',
						startTime: '2026-07-18 15:00:00+02:00',
						endTime: '2026-07-18 16:00:00+02:00'
					},
					{
						id: '1',
						name: 'First',
						stage: { name: 'MAIN' },
						date: '2026-07-17',
						startTime: '2026-07-17 13:00:00+02:00',
						endTime: '2026-07-17 14:30:00+02:00'
					}
				]
			},
			'tmr26'
		);

		expect(normalized.days.map((day) => day.date)).toEqual(['2026-07-17', '2026-07-18']);
		expect(normalized.days[0]?.performances[0]).toMatchObject({
			id: '1',
			artist: 'First',
			stage: 'MAIN',
			startTime: '13:00',
			endTime: '14:30'
		});
	});

	it('labels days by their own calendar date regardless of the viewer timezone', () => {
		const normalized = normalizeTimetable(
			{
				performances: [
					{
						id: '1',
						name: 'A',
						stage: { name: 'MAIN' },
						date: '2026-07-17',
						startTime: '2026-07-17 13:00:00+02:00',
						endTime: '2026-07-17 14:00:00+02:00'
					}
				]
			},
			'tmr26'
		);

		expect(normalized.days[0]?.label).toBe('Friday, July 17');
	});

	it('lifts the first artist image and instagram onto the performance', () => {
		const normalized = normalizeTimetable(
			{
				performances: [
					{
						id: '1',
						name: 'A',
						artists: [{ id: 'x', name: 'A', image: 'img.jpg', instagram: 'https://ig/a' }],
						stage: { name: 'MAIN' },
						date: '2026-07-17',
						startTime: '2026-07-17 13:00:00+02:00',
						endTime: '2026-07-17 14:00:00+02:00'
					}
				]
			},
			'tmr26'
		);

		expect(normalized.days[0]?.performances[0]).toMatchObject({
			artistImage: 'img.jpg',
			instagram: 'https://ig/a'
		});
	});

	it('passes an already-normalized timetable through unchanged', () => {
		const timetable: Timetable = {
			festival: 'Primavera',
			days: [{ date: '2026-06-04', label: 'Thursday', performances: [] }]
		};
		expect(normalizeTimetable(timetable, 'ps26')).toEqual(timetable);
	});

	it('tolerates missing data', () => {
		expect(normalizeTimetable(null, 'tmr26').days).toEqual([]);
		expect(normalizeTimetable(undefined, 'ps26').days).toEqual([]);
	});
});

describe('getTimetableForRoom', () => {
	it('loads the Tomorrowland lineup for a tmr26 room', () => {
		const timetable = getTimetableForRoom('tmr26-abc123');
		expect(timetable.days.length).toBeGreaterThan(0);
		expect(timetable.festival).toMatch(/tomorrowland/i);
	});

	it('loads the same lineup for the bare festival browse id', () => {
		expect(getTimetableForRoom('tmr26').days).toHaveLength(
			getTimetableForRoom('tmr26-abc123').days.length
		);
	});

	it('loads the Primavera lineup for a ps26 room', () => {
		expect(getTimetableForRoom('ps26-abc123').festival).toBe(primaryTimetable.festival);
	});

	it('falls back to the latest festival for a custom room name', () => {
		expect(getTimetableForRoom('birthday-party').days.length).toBeGreaterThan(0);
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

describe('bundled timetable data integrity', () => {
	const timetable = getTimetableForRoom('ps26-abc123');

	it('has exactly 3 days', () => {
		expect(timetable.days).toHaveLength(3);
	});

	it('gives each day a unique ISO date', () => {
		const dates = timetable.days.map((day) => day.date);
		expect(new Set(dates).size).toBe(dates.length);
	});

	it('gives every performance the fields the grid needs', () => {
		for (const day of timetable.days) {
			for (const performance of day.performances) {
				expect(performance.id, `${performance.id} missing id`).toBeTruthy();
				expect(performance.artist, `${performance.id} missing artist`).toBeTruthy();
				expect(performance.stage, `${performance.id} missing stage`).toBeTruthy();
				expect(performance.startTime).toMatch(/^\d{1,2}:\d{2}$/);
				expect(performance.endTime).toMatch(/^\d{1,2}:\d{2}$/);
			}
		}
	});

	it('keeps performance ids unique across all days', () => {
		const ids = timetable.days.flatMap((day) => day.performances.map((p) => p.id));
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('has at least 60 performances per day', () => {
		for (const day of timetable.days) {
			expect(day.performances.length).toBeGreaterThanOrEqual(60);
		}
	});
});

describe('bundled Tomorrowland data integrity', () => {
	const timetable = getTimetableForRoom('tmr26');

	it('normalizes every performance to HH:MM times', () => {
		for (const day of timetable.days) {
			for (const performance of day.performances) {
				expect(performance.startTime).toMatch(/^\d{2}:\d{2}$/);
				expect(performance.endTime).toMatch(/^\d{2}:\d{2}$/);
				expect(performance.stage).toBeTruthy();
			}
		}
	});

	it('keeps performance ids unique across all days', () => {
		const ids = timetable.days.flatMap((day) => day.performances.map((p) => p.id));
		expect(new Set(ids).size).toBe(ids.length);
	});
});
