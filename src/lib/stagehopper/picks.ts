/**
 * @file Pure logic for the "My Picks" tab: grouping marked performances by day and
 * classifying each one against the current time, so the list can dim what's past and
 * flag what's playing now or about to start.
 */

import { stateOf } from './selections.js';
import {
	clockMinutes,
	currentFestivalDate,
	DAY_BOUNDARY_MIN,
	projectClockMinToGrid,
	timeToGridMin
} from './time.js';
import type { Performance, SelectionMap, SelectionState, Timetable } from './types.js';

/** One day's marked performances, in start-time order. */
export interface PickDayGroup {
	/** ISO date, e.g. `2026-07-17`. */
	date: string;
	/** Human label, e.g. `Friday, July 17`. */
	label: string;
	performances: Performance[];
}

/**
 * Marked performances (going or maybe) grouped by day, in chronological order. Days
 * with nothing marked are omitted — an empty day header would just be dead weight in
 * a list that's otherwise a straight read of "what did I pick".
 */
export function groupPicksByDay(timetable: Timetable, mySelections: SelectionMap): PickDayGroup[] {
	const groups: PickDayGroup[] = [];
	for (const day of timetable.days ?? []) {
		const performances = (day.performances ?? [])
			.filter((performance) => stateOf(mySelections, performance.id) > 0)
			.sort(
				(a, b) => timeToGridMin(a.startTime) - timeToGridMin(b.startTime) || a.stage.localeCompare(b.stage)
			);
		if (performances.length > 0) groups.push({ date: day.date, label: day.label, performances });
	}
	return groups;
}

/** How a marked performance relates to the current moment. */
export type PickTiming = 'past' | 'now' | 'soon' | 'future';

/** How far ahead of a set's start it counts as "playing soon". */
const SOON_LEAD_MIN = 30;

/**
 * Classify one performance against the current time.
 *
 * A festival day runs past midnight (see {@link DAY_BOUNDARY_MIN} in time.ts), so
 * "today" for this purpose is the festival day still in progress, not the calendar
 * date — see {@link currentFestivalDate}, the same rule {@link import('./time.js').getCurrentDayIdx} anchors on.
 */
export function timingOf(dayDate: string, performance: Performance, now: Date = new Date()): PickTiming {
	const anchorDate = currentFestivalDate(now);
	if (dayDate < anchorDate) return 'past';
	if (dayDate > anchorDate) return 'future';

	const nowProjected = projectClockMinToGrid(clockMinutes(now), DAY_BOUNDARY_MIN);
	const start = timeToGridMin(performance.startTime);
	const end = timeToGridMin(performance.endTime);
	if (nowProjected >= end) return 'past';
	if (nowProjected >= start) return 'now';
	if (start - nowProjected <= SOON_LEAD_MIN) return 'soon';
	return 'future';
}

/**
 * Whether a pick would trigger a push notification — the bell's state.
 *
 * Mirrors the server's `qualifies()` (lambda/schedule.ts) at the single-mark level: a
 * mark is always required, an explicit `override` wins outright, and absent that, Going
 * always notifies while Maybe only does when `notifyMaybe` is on.
 */
export function effectiveNotify(
	state: SelectionState,
	notifyMaybe: boolean,
	override?: boolean
): boolean {
	if (state === 0) return false;
	if (override !== undefined) return override;
	return state === 1 || notifyMaybe;
}

/**
 * A stable hue (0–359) derived from an artist name, so a missing thumbnail falls back
 * to a tinted initial tile instead of a flat placeholder — different artists land on
 * different colours, and the same artist is always the same colour.
 */
export function artistThumbHue(name: string): number {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = (hash * 31 + name.charCodeAt(i)) | 0;
	}
	return Math.abs(hash) % 360;
}
