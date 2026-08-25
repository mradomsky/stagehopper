/**
 * @file Pure logic for the timetable's list layout: every set on every day as one
 * chronological run, plus the row the list anchors on when it opens.
 *
 * The Picks tab's list (see picks.ts) is the same shape filtered to marked sets; the
 * timing classification and day grouping are shared with it.
 */

import { timingOf, type PickTiming } from './picks.js';
import { timeToGridMin } from './time.js';
import type { Performance, Timetable } from './types.js';

/** One performance, tagged with how it relates to the current moment. */
export interface ScheduleRowModel {
	performance: Performance;
	timing: PickTiming;
}

/** One festival day's sets, in start-time order. Rendered even when empty. */
export interface ScheduleDayGroup {
	/** ISO date, e.g. `2026-07-17`. */
	date: string;
	/** Human label, e.g. `Friday, July 17`. */
	label: string;
	rows: ScheduleRowModel[];
}

/**
 * Every day of the timetable, each with its full lineup sorted by start time and
 * tie-broken by `stageOrder` — the same order the grid draws its columns in, so two
 * sets starting together read the same way in both layouts. Stages missing from
 * `stageOrder` sort last, alphabetically.
 *
 * Unlike {@link import('./picks.js').groupPicksByDay}, empty days are kept: the day tabs
 * exist for every day, and the list's scroll-spy maps tabs onto groups one-for-one.
 */
export function groupScheduleByDay(
	timetable: Timetable,
	stageOrder: string[],
	now: Date = new Date()
): ScheduleDayGroup[] {
	const stageRank = new Map(stageOrder.map((name, index) => [name, index]));
	const rankOf = (stage: string) => stageRank.get(stage) ?? Number.MAX_SAFE_INTEGER;

	return (timetable.days ?? []).map((day) => ({
		date: day.date,
		label: day.label,
		rows: [...(day.performances ?? [])]
			.sort(
				(a, b) =>
					timeToGridMin(a.startTime) - timeToGridMin(b.startTime) ||
					rankOf(a.stage) - rankOf(b.stage) ||
					a.stage.localeCompare(b.stage)
			)
			.map((performance) => ({ performance, timing: timingOf(day.date, performance, now) }))
	}));
}

/**
 * The row to scroll to when the list opens, or null to sit at the day's header.
 *
 * The list opens where the viewer already was — the day the grid was showing — and,
 * when that day is the one in progress, at the current moment within it: the first set
 * that hasn't ended yet. A day already over anchors on its last set, so the viewer lands
 * at the end of it rather than back at breakfast.
 */
export function entryScrollTargetId(
	groups: ScheduleDayGroup[],
	dayIdx: number,
	todayDate: string | null
): string | null {
	const group = groups[dayIdx];
	if (!group || group.rows.length === 0) return null;
	// A day that isn't in progress has no "now" to anchor on — start at the top of it.
	if (group.date !== todayDate) return null;

	const upcoming = group.rows.find((row) => row.timing !== 'past');
	return (upcoming ?? group.rows[group.rows.length - 1])?.performance.id ?? null;
}

/**
 * Which day the list is currently showing, given each day section's offset from the top of
 * the list (px), or -1 when there are no days.
 *
 * The sections are stacked in order, so the day being read is the last one whose top has
 * scrolled past the top of the list. `atEnd` overrides that: a final day shorter than the
 * viewport can be scrolled to in full without its top ever reaching there, and its tab
 * should still light up.
 */
export function activeDayIndex(dayOffsetsPx: number[], atEnd: boolean, tolerancePx: number): number {
	if (dayOffsetsPx.length === 0) return -1;
	if (atEnd) return dayOffsetsPx.length - 1;

	let index = -1;
	for (let i = 0; i < dayOffsetsPx.length; i++) {
		if ((dayOffsetsPx[i] ?? 0) <= tolerancePx) index = i;
	}
	// Above the first day (over-scroll on iOS, say) the first one is still what's in view.
	return index === -1 ? 0 : index;
}
