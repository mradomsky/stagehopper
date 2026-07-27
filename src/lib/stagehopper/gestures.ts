/**
 * @file Touch gesture recognition for the timetable grid.
 */

/** How close to the scroll edge a swipe must start before it flips the day. */
const DEFAULT_EDGE_THRESHOLD_PX = 16;
/** Minimum horizontal travel for a gesture to count as a swipe rather than a tap. */
const MIN_SWIPE_DX = 60;
/** Maximum vertical drift tolerated before a gesture reads as scrolling. */
const MAX_SWIPE_DY = 100;
/** How much more horizontal than vertical the gesture must be. */
const HORIZONTAL_RATIO = 1.5;

export interface DaySwipeInput {
	dx: number;
	dy: number;
	scrollLeftAtStart: number;
	maxScrollLeft: number;
	edgeThreshold?: number;
}

/**
 * Decide whether a horizontal touch gesture should switch the day view.
 * The gesture only counts when it starts at the relevant edge of the scrollable
 * timetable, so normal panning in the middle never flips days.
 */
export function shouldTriggerDaySwipe(input: DaySwipeInput): boolean {
	const edgeThreshold = input.edgeThreshold ?? DEFAULT_EDGE_THRESHOLD_PX;
	const absDx = Math.abs(input.dx);
	const absDy = Math.abs(input.dy);

	if (!(absDx > MIN_SWIPE_DX && absDy < MAX_SWIPE_DY && absDx > absDy * HORIZONTAL_RATIO)) {
		return false;
	}

	if (input.dx < 0) {
		return input.scrollLeftAtStart >= Math.max(0, input.maxScrollLeft - edgeThreshold);
	}
	return input.scrollLeftAtStart <= edgeThreshold;
}
