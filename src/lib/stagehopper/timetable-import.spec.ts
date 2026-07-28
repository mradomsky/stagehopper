import { describe, expect, it } from 'vitest';
import { buildTimetablePreview, validateTimetableImport } from './timetable-import.js';

function goodFile(overrides: Record<string, unknown> = {}) {
	return {
		formatVersion: 1,
		festivalId: 'tmr26',
		days: [
			{
				date: '2026-07-17',
				performances: [
					{ id: 'p1', artist: 'Artist One', stage: 'Main', startTime: '22:00', endTime: '23:30' },
					{ id: 'p2', artist: 'Artist Two', stage: 'Second', startTime: '20:00', endTime: '21:00' }
				]
			},
			{
				date: '2026-07-18',
				performances: [
					{ id: 'p3', artist: 'Artist Three', stage: 'Main', startTime: '19:00', endTime: '20:00' }
				]
			}
		],
		...overrides
	};
}

describe('validateTimetableImport', () => {
	it('accepts a well-formed file', () => {
		const result = validateTimetableImport(goodFile());

		expect(result.errors).toEqual([]);
		expect(result.data).toEqual(goodFile());
	});

	it('carries optional performance fields through untouched', () => {
		const file = goodFile({
			days: [
				{
					date: '2026-07-17',
					performances: [
						{
							id: 'p1',
							artist: 'Artist One',
							stage: 'Main',
							startTime: '22:00',
							endTime: '23:30',
							artists: [{ id: 'a1', name: 'Artist One' }],
							artistImage: 'https://example.com/a.jpg',
							instagram: '@artistone'
						}
					]
				}
			]
		});

		const result = validateTimetableImport(file);

		expect(result.data?.days[0]?.performances[0]).toMatchObject({
			artists: [{ id: 'a1', name: 'Artist One' }],
			artistImage: 'https://example.com/a.jpg',
			instagram: '@artistone'
		});
	});

	it('rejects a non-object payload', () => {
		expect(validateTimetableImport('not an object').errors).toEqual([
			'File must contain a JSON object.'
		]);
		expect(validateTimetableImport(null).errors).toEqual(['File must contain a JSON object.']);
		expect(validateTimetableImport([1, 2, 3]).errors).toEqual(['File must contain a JSON object.']);
	});

	it('rejects the wrong formatVersion', () => {
		const result = validateTimetableImport(goodFile({ formatVersion: 2 }));

		expect(result.errors).toContain('formatVersion must be 1.');
		expect(result.data).toBeUndefined();
	});

	it('rejects a missing festivalId', () => {
		const result = validateTimetableImport(goodFile({ festivalId: '' }));

		expect(result.errors).toContain('festivalId is required.');
	});

	it('rejects an empty days array', () => {
		const result = validateTimetableImport(goodFile({ days: [] }));

		expect(result.errors).toEqual(['days must be a non-empty array.']);
	});

	it('rejects a missing performance id', () => {
		const file = goodFile({
			days: [
				{
					date: '2026-07-17',
					performances: [{ artist: 'A', stage: 'Main', startTime: '22:00', endTime: '23:00' }]
				}
			]
		});

		expect(validateTimetableImport(file).errors.join('\n')).toContain(
			'Day 1, performance 1: id is required.'
		);
	});

	it('rejects duplicate performance ids across different days', () => {
		const file = goodFile({
			days: [
				{
					date: '2026-07-17',
					performances: [{ id: 'dup', artist: 'A', stage: 'Main', startTime: '22:00', endTime: '23:00' }]
				},
				{
					date: '2026-07-18',
					performances: [{ id: 'dup', artist: 'B', stage: 'Main', startTime: '20:00', endTime: '21:00' }]
				}
			]
		});

		expect(validateTimetableImport(file).errors.join('\n')).toContain(
			'Day 2, performance 1: duplicate id "dup".'
		);
	});

	it.each([
		['a bad HH:MM startTime', { startTime: '10pm' }, 'startTime must be HH:MM.'],
		['an out-of-range startTime', { startTime: '25:00' }, 'startTime must be HH:MM.'],
		['a bad HH:MM endTime', { endTime: '99:99' }, 'endTime must be HH:MM.'],
		['a missing artist', { artist: '' }, 'artist is required.'],
		['a missing stage', { stage: '  ' }, 'stage is required.']
	])('rejects %s', (_label, overrides, expected) => {
		const file = goodFile({
			days: [
				{
					date: '2026-07-17',
					performances: [
						{ id: 'p1', artist: 'A', stage: 'Main', startTime: '22:00', endTime: '23:00', ...overrides }
					]
				}
			]
		});

		expect(validateTimetableImport(file).errors.join('\n')).toContain(expected);
	});

	it('rejects a malformed day date', () => {
		const file = goodFile({ days: [{ date: '17-07-2026', performances: [] }] });

		expect(validateTimetableImport(file).errors.join('\n')).toContain(
			'Day 1: date must be an ISO date (YYYY-MM-DD).'
		);
	});

	it('collects every error rather than stopping at the first', () => {
		const file = goodFile({
			formatVersion: 2,
			festivalId: '',
			days: [{ date: 'bad', performances: [{ artist: '', stage: '', startTime: 'x', endTime: 'y' }] }]
		});

		const { errors } = validateTimetableImport(file);

		expect(errors.length).toBeGreaterThan(1);
	});

	it('caps the collected error count', () => {
		const performances = Array.from({ length: 200 }, (_, index) => ({
			id: `p${index}`,
			artist: '',
			stage: '',
			startTime: 'bad',
			endTime: 'bad'
		}));
		const file = goodFile({ days: [{ date: '2026-07-17', performances }] });

		expect(validateTimetableImport(file).errors.length).toBeLessThanOrEqual(50);
	});
});

describe('buildTimetablePreview', () => {
	it('summarizes day count, performance count and the sorted stage list', () => {
		const { data } = validateTimetableImport(goodFile());

		expect(buildTimetablePreview(data!)).toEqual({
			festivalId: 'tmr26',
			dayCount: 2,
			performanceCount: 3,
			stages: ['Main', 'Second']
		});
	});
});
