/**
 * @file One day of the timetable, laid out: which stages have sets, and the vertical extent
 * the grid has to draw.
 *
 * `time.ts` owns the pixel maths and `timetable.ts` owns the stage grouping. What was missing
 * was the module that puts them together, so both callers assembled it themselves — the room
 * page and the admin timetable editor derived the same seven values from the same primitives,
 * character for character, and then threaded the pieces through the grid as separate props.
 *
 * Deliberately not here: the now-line. It depends on the current instant rather than on the
 * day, and only the room draws it — the admin editor was passing `nowTopPx={0}` and
 * `nowVisible={false}` to satisfy a signature it had no use for. Keeping it out leaves this a
 * pure function of its arguments, so it has no reactive state of its own and both callers can
 * wrap it in whatever `$derived` their own state already lives in.
 *
 * Also not here: stage *order*. It differs per caller for real reasons — the room floats
 * favourites to the front, the admin editor applies an in-progress drag — so it is an input.
 */

import { groupPerformancesByStage } from './timetable.js';
import { PX_PER_MIN, buildHourMarkers, computeDayGridRange, type HourMarker } from './time.js';
import type { StageWithPerformances, TimetableDay } from './types.js';

/** A day of the timetable, ready to draw. */
export interface DayGrid {
	/** Stages that have at least one set on this day, in the order given. */
	stages: StageWithPerformances[];
	/** First minute the grid shows, on the day-boundary axis (see `time.ts`). */
	startMin: number;
	/** Last minute the grid shows. */
	endMin: number;
	/** Total height of the grid. */
	heightPx: number;
	/** One `HH:00` label per hour spanned, with its offset. */
	hourMarkers: HourMarker[];
}

/**
 * Lay out one day. `day` may be undefined — a festival with no timetable yet, or a day index
 * that outran the days array — in which case the range falls back to a full 24 hours from the
 * day boundary and no stage has any sets.
 */
export function buildDayGrid(
	day: TimetableDay | undefined,
	stageOrder: readonly string[]
): DayGrid {
	const range = computeDayGridRange(day);
	return {
		stages: groupPerformancesByStage(day, stageOrder),
		startMin: range.start,
		endMin: range.end,
		heightPx: (range.end - range.start) * PX_PER_MIN,
		hourMarkers: buildHourMarkers(range.start, range.end)
	};
}
