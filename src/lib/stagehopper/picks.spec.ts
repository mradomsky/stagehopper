import { describe, expect, it } from 'vitest';
import { artistThumbHue, effectiveNotify, firstUpcomingPickId, groupPicksByDay, timingOf } from './picks.js';
import type { Performance, SelectionMap, Timetable, TimetableDay } from './types.js';

function performance(id: string, startTime: string, endTime = '23:59', stage = 'S'): Performance {
	return { id, artist: id, stage, startTime, endTime };
}

function day(date: string, performances: Performance[]): TimetableDay {
	return { date, label: date, performances };
}

describe('groupPicksByDay', () => {
	const timetable: Timetable = {
		festival: 'f',
		days: [
			day('2026-07-17', [
				performance('a', '16:00'),
				performance('b', '13:00'),
				performance('c', '14:00')
			]),
			day('2026-07-18', [performance('d', '12:00')])
		]
	};

	it('keeps only marked performances, sorted by start time', () => {
		const selections: SelectionMap = { a: 1, c: 2, d: 1 };
		const groups = groupPicksByDay(timetable, selections);
		expect(groups).toHaveLength(2);
		expect(groups[0]!.performances.map((p) => p.id)).toEqual(['c', 'a']);
	});

	it('omits days with nothing marked', () => {
		const selections: SelectionMap = { a: 1 };
		const groups = groupPicksByDay(timetable, selections);
		expect(groups.map((g) => g.date)).toEqual(['2026-07-17']);
	});

	it('breaks ties at the same start time by stage name', () => {
		const timetableSameStart: Timetable = {
			festival: 'f',
			days: [
				day('2026-07-17', [
					performance('a', '16:00', '17:00', 'Zed Stage'),
					performance('b', '16:00', '17:00', 'Alpha Stage')
				])
			]
		};
		const selections: SelectionMap = { a: 1, b: 1 };
		const groups = groupPicksByDay(timetableSameStart, selections);
		expect(groups[0]!.performances.map((p) => p.id)).toEqual(['b', 'a']);
	});

	it('returns nothing when nothing is marked', () => {
		expect(groupPicksByDay(timetable, {})).toEqual([]);
	});
});

describe('timingOf', () => {
	const dayDate = '2026-07-18';

	it('is "now" while the set is playing', () => {
		const perf = performance('a', '20:00', '21:00');
		expect(timingOf(dayDate, perf, new Date(2026, 6, 18, 20, 30))).toBe('now');
	});

	it('is "soon" within the lead window before the set starts', () => {
		const perf = performance('a', '20:00', '21:00');
		expect(timingOf(dayDate, perf, new Date(2026, 6, 18, 19, 45))).toBe('soon');
	});

	it('is "future" outside the lead window', () => {
		const perf = performance('a', '20:00', '21:00');
		expect(timingOf(dayDate, perf, new Date(2026, 6, 18, 19, 0))).toBe('future');
	});

	it('is "past" once the set has ended', () => {
		const perf = performance('a', '20:00', '21:00');
		expect(timingOf(dayDate, perf, new Date(2026, 6, 18, 21, 30))).toBe('past');
	});

	it('is "past" for a day already gone', () => {
		const perf = performance('a', '20:00', '21:00');
		expect(timingOf(dayDate, perf, new Date(2026, 6, 19, 12, 0))).toBe('past');
	});

	it('keeps the previous festival day "current" before the boundary rolls it over', () => {
		// 02:00 the next morning still belongs to dayDate's festival day, not the 19th's.
		const perf = performance('a', '23:00', '23:59');
		expect(timingOf(dayDate, perf, new Date(2026, 6, 19, 2, 0))).toBe('past');
	});

	it('is "future" for a day not yet reached', () => {
		const perf = performance('a', '20:00', '21:00');
		expect(timingOf(dayDate, perf, new Date(2026, 6, 17, 12, 0))).toBe('future');
	});

	it('handles a post-midnight set relative to its own festival day', () => {
		const perf = performance('a', '01:00', '02:30');
		expect(timingOf(dayDate, perf, new Date(2026, 6, 19, 1, 30))).toBe('now');
		expect(timingOf(dayDate, perf, new Date(2026, 6, 19, 3, 0))).toBe('past');
	});
});

describe('firstUpcomingPickId', () => {
	it('returns the first performance that has not ended, across days', () => {
		const groups = [
			{
				date: '2026-07-17',
				label: '2026-07-17',
				performances: [performance('a', '20:00', '21:00')]
			},
			{
				date: '2026-07-18',
				label: '2026-07-18',
				performances: [performance('b', '13:00', '14:00'), performance('c', '20:00', '21:00')]
			}
		];
		expect(firstUpcomingPickId(groups, new Date(2026, 6, 18, 15, 0))).toBe('c');
	});

	it('returns null once every pick is in the past', () => {
		const groups = [
			{
				date: '2026-07-17',
				label: '2026-07-17',
				performances: [performance('a', '20:00', '21:00')]
			}
		];
		expect(firstUpcomingPickId(groups, new Date(2026, 6, 19, 12, 0))).toBeNull();
	});
});

describe('effectiveNotify', () => {
	it('is false when unmarked, regardless of override', () => {
		expect(effectiveNotify(0, true)).toBe(false);
		expect(effectiveNotify(0, true, true)).toBe(false);
	});

	it('going always notifies by default', () => {
		expect(effectiveNotify(1, false)).toBe(true);
		expect(effectiveNotify(1, true)).toBe(true);
	});

	it('maybe notifies only when notifyMaybe is on', () => {
		expect(effectiveNotify(2, false)).toBe(false);
		expect(effectiveNotify(2, true)).toBe(true);
	});

	it('an explicit override replaces the default for a marked pick', () => {
		expect(effectiveNotify(1, false, false)).toBe(false);
		expect(effectiveNotify(2, false, true)).toBe(true);
	});
});

describe('artistThumbHue', () => {
	it('is stable for the same name', () => {
		expect(artistThumbHue('Chet Faker')).toBe(artistThumbHue('Chet Faker'));
	});

	it('differs across names', () => {
		expect(artistThumbHue('Chet Faker')).not.toBe(artistThumbHue('Biffy Clyro'));
	});

	it('stays within a valid hue range', () => {
		const hue = artistThumbHue('¥Ø U$K€ ¥UK1MAT$U');
		expect(hue).toBeGreaterThanOrEqual(0);
		expect(hue).toBeLessThan(360);
	});
});
