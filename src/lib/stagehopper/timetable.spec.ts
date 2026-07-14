import { describe, it, expect } from 'vitest';
import timetable from '$lib/stagehopper/timetable.json';

describe('timetable data integrity', () => {
	it('has exactly 3 days', () => {
		expect(timetable.days).toHaveLength(3);
	});

	it('each day has a unique ISO date', () => {
		const dates = timetable.days.map((d) => d.date);
		expect(new Set(dates).size).toBe(3);
	});

	it('every performance has required fields', () => {
		for (const day of timetable.days) {
			for (const p of day.performances) {
				expect(p.id, `${p.id} missing id`).toBeTruthy();
				expect(p.artist, `${p.id} missing artist`).toBeTruthy();
				expect(p.stage, `${p.id} missing stage`).toBeTruthy();
				expect(p.startTime, `${p.id} missing startTime`).toBeTruthy();
				expect(p.endTime, `${p.id} missing endTime`).toBeTruthy();
			}
		}
	});

	it('all performance IDs are unique across all days', () => {
		const ids = timetable.days.flatMap((d) => d.performances.map((p) => p.id));
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('start/end times match HH:MM format', () => {
		const re = /^\d{1,2}:\d{2}$/;
		for (const day of timetable.days) {
			for (const p of day.performances) {
				expect(p.startTime, `${p.id} startTime`).toMatch(re);
				expect(p.endTime, `${p.id} endTime`).toMatch(re);
			}
		}
	});

	it('has at least 60 performances per day', () => {
		for (const day of timetable.days) {
			expect(day.performances.length).toBeGreaterThanOrEqual(60);
		}
	});
});
