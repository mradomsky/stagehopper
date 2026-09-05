import { describe, expect, it } from 'vitest';
import {
	FESTIVAL_FIELDS,
	FESTIVAL_FIELD_NAMES,
	isFestivalRecord,
	toManifestEntry,
	validateFestivalRecord,
	type FestivalRecord
} from './festival-fields.js';

const full: Required<FestivalRecord> = {
	id: 'fest26',
	name: 'Fest 2026',
	location: 'Testville',
	startDate: '2026-08-01',
	endDate: '2026-08-03',
	timezone: 'Europe/Berlin',
	imageUrl: '/img.jpg',
	mapUrl: '/map.jpg',
	description: 'Three days.',
	stageColors: { Main: '#3498db' },
	stageOrder: ['Main']
};

describe('FESTIVAL_FIELDS', () => {
	it('covers every key a full record can carry, and nothing else', () => {
		expect([...FESTIVAL_FIELD_NAMES].sort()).toEqual(Object.keys(full).sort());
	});

	it('gives every field a missing-value message', () => {
		for (const field of FESTIVAL_FIELD_NAMES) expect(FESTIVAL_FIELDS[field].missing).toBeTruthy();
	});
});

describe('validateFestivalRecord', () => {
	it('accepts a full record and returns a copy holding only schema keys', () => {
		const result = validateFestivalRecord({ ...full, internalNote: 'nope' });
		expect(result.error).toBeUndefined();
		expect(result.record).toEqual(full);
		expect(result.record).not.toBe(full);
	});

	it('requires timezone on write even though the type marks it optional', () => {
		const { timezone: _omit, ...legacy } = full;
		expect(validateFestivalRecord(legacy).error).toMatch(/timezone must be a valid IANA timezone/);
	});

	it.each([
		['not an object', 'x', /must be an object/],
		['a bad id', { ...full, id: 'Nope!' }, /festival id must be 2-10/],
		['a blank name', { ...full, name: ' ' }, /name is required/],
		['a non-string location', { ...full, location: 3 }, /location is required/],
		['a malformed date', { ...full, endDate: '3 Aug' }, /endDate must be an ISO date/],
		['reversed dates', { ...full, startDate: '2026-09-01' }, /startDate must not be after endDate/],
		['an unknown timezone', { ...full, timezone: 'Mars/Olympus' }, /timezone must be a valid/],
		['a non-string mapUrl', { ...full, mapUrl: 1 }, /mapUrl must be a string/],
		['a long description', { ...full, description: 'x'.repeat(1001) }, /at most 1000/],
		['array stageColors', { ...full, stageColors: ['#ffffff'] }, /stageColors must be an object/],
		['a non-string colour', { ...full, stageColors: { Main: 7 } }, /must be a #rrggbb colour/],
		['a bad colour', { ...full, stageColors: { Main: 'blue' } }, /must be a #rrggbb colour/],
		['an empty stage key', { ...full, stageColors: { ' ': '#ffffff' } }, /keys must not be empty/],
		['a non-array stageOrder', { ...full, stageOrder: 'Main' }, /stageOrder must be an array$/],
		['a blank stage name', { ...full, stageOrder: [' '] }, /non-empty strings/]
	])('rejects %s', (_label, input, message) => {
		expect(validateFestivalRecord(input).error).toMatch(message);
	});
});

describe('isFestivalRecord', () => {
	it('accepts a legacy entry without a timezone', () => {
		const { timezone: _omit, ...legacy } = full;
		expect(isFestivalRecord(legacy)).toBe(true);
	});

	it('is shape-only: write-side rules do not apply on read', () => {
		expect(isFestivalRecord({ ...full, id: 'NOT-VALID-ON-WRITE', stageColors: { Main: 'blue' } })).toBe(
			true
		);
	});

	it.each([
		['a missing required field', (() => { const { name: _n, ...rest } = full; return rest; })()],
		['a wrong-kind field', { ...full, stageOrder: 'Main' }],
		['array stageColors', { ...full, stageColors: [] }],
		['null', null]
	])('rejects %s', (_label, input) => {
		expect(isFestivalRecord(input)).toBe(false);
	});
});

describe('toManifestEntry', () => {
	it('keeps schema fields in schema order and drops the rest', () => {
		const entry = toManifestEntry({ zzz: 1, ...full, extra: true });
		expect(entry).toEqual(full);
		expect(Object.keys(entry ?? {})).toEqual(FESTIVAL_FIELD_NAMES);
	});

	it('returns null for a row that fails the shape guard', () => {
		expect(toManifestEntry({ id: 'broken' })).toBeNull();
	});
});
