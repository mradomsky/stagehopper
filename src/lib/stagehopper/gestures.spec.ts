import { describe, expect, it } from 'vitest';
import { shouldTriggerDaySwipe } from './gestures.js';

describe('shouldTriggerDaySwipe', () => {
	it('allows a next-day swipe only from the right edge', () => {
		expect(
			shouldTriggerDaySwipe({ dx: -90, dy: 10, scrollLeftAtStart: 284, maxScrollLeft: 300 })
		).toBe(true);
		expect(
			shouldTriggerDaySwipe({ dx: -90, dy: 10, scrollLeftAtStart: 180, maxScrollLeft: 300 })
		).toBe(false);
	});

	it('allows a previous-day swipe only from the left edge', () => {
		expect(
			shouldTriggerDaySwipe({ dx: 90, dy: 10, scrollLeftAtStart: 10, maxScrollLeft: 300 })
		).toBe(true);
		expect(
			shouldTriggerDaySwipe({ dx: 90, dy: 10, scrollLeftAtStart: 40, maxScrollLeft: 300 })
		).toBe(false);
	});

	it('ignores gestures that are too short to be swipes', () => {
		expect(
			shouldTriggerDaySwipe({ dx: 40, dy: 10, scrollLeftAtStart: 0, maxScrollLeft: 300 })
		).toBe(false);
	});

	it('ignores gestures that drift too far vertically', () => {
		expect(
			shouldTriggerDaySwipe({ dx: 90, dy: 120, scrollLeftAtStart: 0, maxScrollLeft: 300 })
		).toBe(false);
	});

	it('ignores diagonal gestures that are not clearly horizontal', () => {
		expect(
			shouldTriggerDaySwipe({ dx: 70, dy: 60, scrollLeftAtStart: 0, maxScrollLeft: 300 })
		).toBe(false);
	});

	it('treats an unscrollable grid as being at both edges', () => {
		expect(shouldTriggerDaySwipe({ dx: -90, dy: 0, scrollLeftAtStart: 0, maxScrollLeft: 0 })).toBe(
			true
		);
	});

	it('honours a custom edge threshold', () => {
		expect(
			shouldTriggerDaySwipe({
				dx: 90,
				dy: 0,
				scrollLeftAtStart: 40,
				maxScrollLeft: 300,
				edgeThreshold: 50
			})
		).toBe(true);
	});
});
