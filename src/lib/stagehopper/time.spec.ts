import { describe, expect, it } from 'vitest';
import {
	buildHourMarkers,
	clockMinutes,
	computeGridStart,
	currentGridMin,
	DAY_BOUNDARY_MIN,
	durationPx,
	getInitialDayIdx,
	GRID_SPAN_MIN,
	localIsoDate,
	projectClockMinToGrid,
	PX_PER_MIN,
	timeToGridMin,
	timeToTopPx
} from './time.js';
import type { Performance, TimetableDay } from './types.js';

function performance(startTime: string, endTime = '23:59'): Performance {
	return { id: `${startTime}-${endTime}`, artist: 'A', stage: 'S', startTime, endTime };
}

function day(date: string, performances: Performance[]): TimetableDay {
	return { date, label: date, performances };
}

describe('timeToGridMin', () => {
	it('maps an afternoon time to minutes since midnight', () => {
		expect(timeToGridMin('14:00')).toBe(840);
	});

	it('treats midnight as the next calendar day', () => {
		expect(timeToGridMin('00:00')).toBe(1440);
	});

	it('treats post-midnight sets as the next calendar day', () => {
		expect(timeToGridMin('02:30')).toBe(1590);
	});

	it('keeps late-evening times on the same day', () => {
		expect(timeToGridMin('23:59')).toBe(1439);
	});

	it('falls back to the day boundary for unparseable input', () => {
		expect(timeToGridMin('not-a-time')).toBe(DAY_BOUNDARY_MIN);
	});
});

describe('computeGridStart', () => {
	it('starts 2.5 hours before the earliest daytime set', () => {
		const days = [day('2026-07-17', [performance('16:00'), performance('13:00')])];
		expect(computeGridStart(days)).toBe(13 * 60 - 150);
	});

	it('ignores post-midnight sets when anchoring the grid', () => {
		const days = [day('2026-07-17', [performance('01:00'), performance('12:00')])];
		expect(computeGridStart(days)).toBe(12 * 60 - 150);
	});

	it('keeps every performance of the day at or below the top of the grid', () => {
		const days = [
			day('2026-07-17', [performance('13:00'), performance('18:00'), performance('01:00')])
		];
		const gridStart = computeGridStart(days);

		for (const performance of days[0]?.performances ?? []) {
			expect(timeToTopPx(performance.startTime, gridStart)).toBeGreaterThanOrEqual(0);
		}
	});

	it('falls back to the day boundary for an empty timetable', () => {
		expect(computeGridStart([])).toBe(DAY_BOUNDARY_MIN);
		expect(computeGridStart(undefined)).toBe(DAY_BOUNDARY_MIN);
	});
});

describe('buildHourMarkers', () => {
	it('produces 24 markers starting at the grid start hour', () => {
		const markers = buildHourMarkers(9 * 60);
		expect(markers).toHaveLength(24);
		expect(markers[0]).toEqual({ label: '09:00', top: 0 });
		expect(markers[1]?.label).toBe('10:00');
	});

	it('wraps past midnight with increasing offsets', () => {
		const markers = buildHourMarkers(9 * 60);
		const midnight = markers.find((marker) => marker.label === '00:00');
		expect(midnight?.top).toBe((1440 - 540) * PX_PER_MIN);
	});
});

describe('durationPx', () => {
	it('scales the set length', () => {
		expect(durationPx('14:00', '15:00')).toBe(60 * PX_PER_MIN);
	});

	it('floors very short sets so they stay tappable', () => {
		expect(durationPx('14:00', '14:05')).toBe(22);
	});

	it('handles sets that run past midnight', () => {
		expect(durationPx('23:30', '00:30')).toBe(60 * PX_PER_MIN);
	});
});

describe('currentGridMin', () => {
	it('projects an evening time directly', () => {
		expect(currentGridMin(DAY_BOUNDARY_MIN, new Date(2026, 6, 17, 22, 30))).toBe(22 * 60 + 30);
	});

	it('projects a post-midnight time onto the previous festival day', () => {
		expect(currentGridMin(DAY_BOUNDARY_MIN, new Date(2026, 6, 18, 2, 0))).toBe(1440 + 120);
	});

	it('lands inside the grid at every minute of the day, whenever the grid starts', () => {
		// A grid built from a festival whose first set is late (Primavera opens at
		// 14:00) still runs a full 24 hours, so no wall-clock time may fall outside it.
		for (const gridStartMin of [0, 7 * 60, DAY_BOUNDARY_MIN, 14 * 60]) {
			for (let minute = 0; minute < 1440; minute += 15) {
				const now = new Date(2026, 6, 17, Math.floor(minute / 60), minute % 60);
				const projected = currentGridMin(gridStartMin, now);

				expect(projected, `${minute} min with grid start ${gridStartMin}`).toBeGreaterThanOrEqual(
					gridStartMin
				);
				expect(projected).toBeLessThan(gridStartMin + GRID_SPAN_MIN);
			}
		}
	});
});

describe('projectClockMinToGrid', () => {
	it('leaves times at or after the grid start alone', () => {
		expect(projectClockMinToGrid(14 * 60, 9 * 60)).toBe(840);
	});

	it('wraps times before the grid start onto the tail of the grid', () => {
		expect(projectClockMinToGrid(10 * 60, 14 * 60)).toBe(1440 + 600);
	});
});

describe('clockMinutes', () => {
	it('counts minutes since local midnight', () => {
		expect(clockMinutes(new Date(2026, 6, 17, 10, 30))).toBe(630);
	});
});

describe('localIsoDate', () => {
	it('uses local calendar fields rather than UTC', () => {
		// 23:30 local on the 17th is the 18th in UTC for positive offsets; the festival
		// day the viewer is standing in is what matters.
		expect(localIsoDate(new Date(2026, 6, 17, 23, 30))).toBe('2026-07-17');
	});
});

describe('getInitialDayIdx', () => {
	const days = [day('2026-07-17', []), day('2026-07-18', []), day('2026-07-19', [])];

	it('selects today when the festival is running', () => {
		expect(getInitialDayIdx(days, new Date(2026, 6, 18, 12, 0))).toBe(1);
	});

	it('falls back to the first day outside the festival', () => {
		expect(getInitialDayIdx(days, new Date(2026, 0, 1, 12, 0))).toBe(0);
	});

	it('tolerates an empty timetable', () => {
		expect(getInitialDayIdx([], new Date())).toBe(0);
	});
});
