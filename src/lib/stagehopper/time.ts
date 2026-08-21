/**
 * @file Mapping between festival clock times and vertical grid positions.
 *
 * A festival "day" does not end at midnight — sets that start at 01:00 belong to the
 * night before. Every time is therefore projected onto a single continuous axis of
 * minutes where anything earlier than {@link DAY_BOUNDARY_MIN} counts as the next
 * calendar day (i.e. gets +1440).
 */

import type { TimetableDay } from './types.js';

/** Clock time (in minutes) at which one festival day rolls over to the next. */
export const DAY_BOUNDARY_MIN = 9 * 60; // 09:00

/** Vertical scale of the timetable. */
export const PX_PER_MIN = 1.5;

/** Minutes of empty grid shown above the earliest performance of the festival. */
const GRID_LEAD_IN_MIN = 150;

/** The grid always spans a full 24 hours from its start. */
export const GRID_SPAN_MIN = 24 * 60;

/** Shortest a performance block may render, so 15-minute sets stay readable. */
const MIN_BLOCK_PX = 22;

export interface HourMarker {
	/** `HH:00` label. */
	label: string;
	/** Offset in pixels from the top of the grid. */
	top: number;
}

/**
 * Convert an HH:MM time string to minutes on the festival grid.
 * Times before {@link DAY_BOUNDARY_MIN} are treated as post-midnight (next calendar day).
 */
export function timeToGridMin(hhmm: string): number {
	const [rawHours, rawMinutes] = hhmm.split(':');
	const hours = Number(rawHours);
	const minutes = Number(rawMinutes);
	if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
		return DAY_BOUNDARY_MIN;
	}
	const total = hours * 60 + minutes;
	return total < DAY_BOUNDARY_MIN ? total + 1440 : total;
}

/**
 * Where the visible grid starts, derived from the earliest daytime set across the
 * whole festival, minus a lead-in.
 *
 * The earliest daytime start is the minimum of every projected time (post-midnight
 * sets land at >= 1440), so starting below it keeps every block on the grid.
 */
export function computeGridStart(days: TimetableDay[] | undefined): number {
	let earliest = Infinity;
	for (const day of days ?? []) {
		for (const performance of day.performances ?? []) {
			const min = timeToGridMin(performance.startTime);
			// Only daytime starts anchor the grid; post-midnight sets (>= 1440) belong to the tail.
			if (min < 1440 && min < earliest) earliest = min;
		}
	}
	if (!Number.isFinite(earliest)) return DAY_BOUNDARY_MIN;
	return Math.max(0, earliest - GRID_LEAD_IN_MIN);
}

/** One marker per hour of the 24-hour window, starting at the grid's first full hour. */
export function buildHourMarkers(gridStartMin: number): HourMarker[] {
	const markers: HourMarker[] = [];
	const startHour = Math.floor(gridStartMin / 60);
	for (let i = 0; i < 24; i++) {
		const hour = (startHour + i) % 24;
		const clockMin = hour * 60;
		const gridMin = clockMin < gridStartMin ? clockMin + 1440 : clockMin;
		markers.push({
			label: `${String(hour).padStart(2, '0')}:00`,
			top: (gridMin - gridStartMin) * PX_PER_MIN
		});
	}
	return markers;
}

/** Pixel offset of a clock time from the top of the grid. */
export function timeToTopPx(hhmm: string, gridStartMin: number): number {
	return (timeToGridMin(hhmm) - gridStartMin) * PX_PER_MIN;
}

/** Pixel height of a performance block, floored so short sets stay tappable. */
export function durationPx(startTime: string, endTime: string): number {
	return Math.max(MIN_BLOCK_PX, (timeToGridMin(endTime) - timeToGridMin(startTime)) * PX_PER_MIN);
}

/** Wall-clock minutes since midnight, e.g. 630 for 10:30. */
export function clockMinutes(now: Date = new Date()): number {
	return now.getHours() * 60 + now.getMinutes();
}

/**
 * Project a wall-clock time onto the grid axis.
 *
 * Wrapping is relative to where the grid actually starts, not to
 * {@link DAY_BOUNDARY_MIN}: a grid that opens at 14:00 runs until 14:00 the next day,
 * so 10:00 belongs at its tail. Wrapping on the fixed boundary instead would leave
 * every time between the boundary and a later grid start off the axis entirely.
 */
export function projectClockMinToGrid(clockMin: number, gridStartMin: number): number {
	return clockMin < gridStartMin ? clockMin + 1440 : clockMin;
}

/** Today's date as `YYYY-MM-DD` in the viewer's own timezone (not UTC). */
export function localIsoDate(now: Date = new Date()): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

/**
 * The date of the festival day currently in progress, as `YYYY-MM-DD`.
 *
 * A festival day runs past midnight: sets between midnight and {@link DAY_BOUNDARY_MIN}
 * are filed under the *previous* calendar date (ps26 alone files 22 of its 72 opening-day
 * sets that way). So before the boundary the day still in progress is yesterday's, and
 * matching on the raw calendar date would skip past the sets currently on stage.
 */
export function currentFestivalDate(now: Date = new Date()): string {
	const anchor = new Date(now);
	if (clockMinutes(now) < DAY_BOUNDARY_MIN) {
		anchor.setDate(anchor.getDate() - 1);
	}
	return localIsoDate(anchor);
}

/**
 * Index of the festival day currently being played, or 0 when the festival is not
 * running today. See {@link currentFestivalDate} for the day-boundary rule.
 */
export function getCurrentDayIdx(days: TimetableDay[] | undefined, now: Date = new Date()): number {
	const today = currentFestivalDate(now);
	return (days ?? []).findIndex((day) => day.date === today);
}

export function getInitialDayIdx(days: TimetableDay[] | undefined, now: Date = new Date()): number {
	const idx = getCurrentDayIdx(days, now);
	return idx >= 0 ? idx : 0;
}
