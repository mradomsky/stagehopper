import { describe, expect, it } from 'vitest';
import { buildDayGrid } from './day-grid.js';
import { DAY_BOUNDARY_MIN, GRID_SPAN_MIN, PX_PER_MIN } from './time.js';
import type { Performance, TimetableDay } from './types.js';

function perf(id: string, stage: string, startTime: string, endTime: string): Performance {
	return { id, artist: id, stage, startTime, endTime };
}

const day: TimetableDay = {
	date: '2026-07-17',
	label: 'Friday, July 17',
	performances: [
		perf('p1', 'MAIN', '18:00', '19:00'),
		perf('p2', 'SIDE', '20:00', '21:00'),
		perf('p3', 'MAIN', '22:00', '23:00')
	]
};

describe('buildDayGrid', () => {
	it('groups a day into the stages given, in that order', () => {
		const grid = buildDayGrid(day, ['SIDE', 'MAIN']);

		expect(grid.stages.map((s) => s.name)).toEqual(['SIDE', 'MAIN']);
		expect(grid.stages[1]?.performances.map((p) => p.id)).toEqual(['p1', 'p3']);
	});

	it('drops a stage with no sets on this day', () => {
		const grid = buildDayGrid(day, ['MAIN', 'SIDE', 'EMPTY']);
		expect(grid.stages.map((s) => s.name)).toEqual(['MAIN', 'SIDE']);
	});

	it('derives height from the range, in the grid scale', () => {
		const grid = buildDayGrid(day, ['MAIN', 'SIDE']);
		expect(grid.heightPx).toBeCloseTo((grid.endMin - grid.startMin) * PX_PER_MIN);
	});

	it('labels every hour the range spans', () => {
		const grid = buildDayGrid(day, ['MAIN']);
		const hours = Math.ceil(grid.endMin / 60) - Math.floor(grid.startMin / 60);

		expect(grid.hourMarkers).toHaveLength(hours);
		// Markers are positioned against the same origin the blocks are.
		expect(grid.hourMarkers[0]?.top).toBeLessThanOrEqual(0);
	});

	it('falls back to a full day when there is no day to lay out', () => {
		const grid = buildDayGrid(undefined, ['MAIN']);

		expect(grid.stages).toEqual([]);
		expect(grid.startMin).toBe(DAY_BOUNDARY_MIN);
		expect(grid.endMin).toBe(DAY_BOUNDARY_MIN + GRID_SPAN_MIN);
	});

	it('gives the same layout to both callers for the same day and order', () => {
		// The room and the admin editor differ only in how they choose stageOrder; once
		// chosen, the layout must not depend on which of them asked for it.
		expect(buildDayGrid(day, ['MAIN', 'SIDE'])).toEqual(buildDayGrid(day, ['MAIN', 'SIDE']));
	});
});
