import { describe, expect, it } from 'vitest';
import { activeDayIndex, entryScrollTargetId, groupScheduleByDay } from './schedule-list.js';
import type { Performance, Timetable } from './types.js';

function perf(id: string, stage: string, startTime: string, endTime: string): Performance {
	return { id, artist: id.toUpperCase(), stage, startTime, endTime };
}

const timetable: Timetable = {
	festival: 'tmr26',
	days: [
		{
			date: '2026-07-17',
			label: 'Friday, July 17',
			performances: [
				perf('late', 'STAGE B', '23:00', '23:45'),
				perf('past', 'STAGE A', '13:00', '14:00'),
				perf('now', 'STAGE B', '15:00', '16:00'),
				// Same slot as `now`, so the stage order decides which comes first.
				perf('now-a', 'STAGE A', '15:00', '16:00')
			]
		},
		{ date: '2026-07-18', label: 'Saturday, July 18', performances: [] }
	]
};

/** During `now`'s set on the Friday. */
const duringNow = new Date('2026-07-17T15:30:00');

describe('groupScheduleByDay', () => {
	it('keeps every day, including one with nothing scheduled', () => {
		const groups = groupScheduleByDay(timetable, ['STAGE A', 'STAGE B'], duringNow);

		expect(groups.map((group) => group.date)).toEqual(['2026-07-17', '2026-07-18']);
		expect(groups[1]?.rows).toEqual([]);
	});

	it('sorts by start time, tie-broken by the grid’s stage order', () => {
		const groups = groupScheduleByDay(timetable, ['STAGE B', 'STAGE A'], duringNow);

		expect(groups[0]?.rows.map((row) => row.performance.id)).toEqual([
			'past',
			'now',
			'now-a',
			'late'
		]);
	});

	it('sorts stages missing from the order last, alphabetically', () => {
		const groups = groupScheduleByDay(timetable, [], duringNow);

		expect(groups[0]?.rows.map((row) => row.performance.id)).toEqual([
			'past',
			'now-a',
			'now',
			'late'
		]);
	});

	it('tags each row against the current moment', () => {
		const groups = groupScheduleByDay(timetable, ['STAGE A', 'STAGE B'], duringNow);
		const timings = Object.fromEntries(
			(groups[0]?.rows ?? []).map((row) => [row.performance.id, row.timing])
		);

		expect(timings).toMatchObject({ past: 'past', now: 'now', late: 'future' });
		expect(groups[1]?.rows).toHaveLength(0);
	});
});

describe('entryScrollTargetId', () => {
	const groups = groupScheduleByDay(timetable, ['STAGE A', 'STAGE B'], duringNow);

	it('anchors on the first set that has not ended on the day in progress', () => {
		expect(entryScrollTargetId(groups, 0, '2026-07-17')).toBe('now-a');
	});

	it('sits at the header when the day being viewed is not the one in progress', () => {
		expect(entryScrollTargetId(groups, 0, '2026-07-18')).toBeNull();
		expect(entryScrollTargetId(groups, 0, null)).toBeNull();
	});

	it('anchors on the last set once the day in progress is over', () => {
		const overGroups = groupScheduleByDay(
			timetable,
			['STAGE A', 'STAGE B'],
			new Date('2026-07-18T02:00:00')
		);

		// 02:00 still belongs to the Friday festival day, which by then is finished.
		expect(entryScrollTargetId(overGroups, 0, '2026-07-17')).toBe('late');
	});

	it('has nothing to anchor on for an empty or unknown day', () => {
		expect(entryScrollTargetId(groups, 1, '2026-07-18')).toBeNull();
		expect(entryScrollTargetId(groups, 9, '2026-07-17')).toBeNull();
	});
});

describe('activeDayIndex', () => {
	// Offsets are each day section's distance from the top of the list; a day being read has
	// scrolled its own top to or past there, so its offset is zero or negative.
	it('picks the last day whose top has passed the top of the list', () => {
		expect(activeDayIndex([0, 420, 900], false, 2)).toBe(0);
		expect(activeDayIndex([-380, 0, 900], false, 2)).toBe(1);
		expect(activeDayIndex([-800, -380, 0], false, 2)).toBe(2);
	});

	it('allows a pixel of slack for sub-pixel rounding', () => {
		expect(activeDayIndex([-500, 1.4, 900], false, 2)).toBe(1);
	});

	it('stays on the first day when scrolled above every one of them', () => {
		expect(activeDayIndex([40, 500, 980], false, 2)).toBe(0);
	});

	it('reports the last day once the list is scrolled to the bottom', () => {
		// A final day shorter than the viewport never gets its top to the top of the list.
		expect(activeDayIndex([-900, -400, 300], true, 2)).toBe(2);
	});

	it('has no day to report when the timetable is empty', () => {
		expect(activeDayIndex([], false, 2)).toBe(-1);
		expect(activeDayIndex([], true, 2)).toBe(-1);
	});
});
