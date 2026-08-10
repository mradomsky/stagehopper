import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	compareFestivalsForLanding,
	DEFAULT_FESTIVALS,
	ensureFestivalsLoaded,
	FESTIVALS,
	FESTIVAL_DATA_PATH,
	formatDateRange,
	getFestivalById,
	getFestivalByPrefix,
	getLatestFestival,
	isFestivalBrowseId,
	loadFestivals,
	normalizeFestival
} from './festivals.svelte.js';
import type { FestivalRecord } from './types.js';

function record(overrides: Partial<FestivalRecord> = {}): FestivalRecord {
	return {
		id: 'test26',
		name: 'Test Festival',
		location: 'Testville',
		startDate: '2026-07-17',
		endDate: '2026-07-20',
		...overrides
	};
}

describe('festival configuration', () => {
	it('gives every festival a unique id and a matching prefix', () => {
		const ids = FESTIVALS.map((f) => f.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const f of FESTIVALS) {
			expect(f.prefix).toBe(`${f.id}-`);
		}
	});
});

describe('formatDateRange', () => {
	it('formats a range within a single month', () => {
		expect(formatDateRange('2026-07-17', '2026-07-20')).toBe('July 17–20');
	});

	it('formats a range across a month boundary', () => {
		expect(formatDateRange('2026-06-28', '2026-07-02')).toBe('June 28 – July 2');
	});

	it('formats a range across a year boundary', () => {
		expect(formatDateRange('2026-12-30', '2027-01-02')).toBe(
			'December 30, 2026 – January 2, 2027'
		);
	});
});

describe('normalizeFestival', () => {
	it('derives the prefix, subtitle and past-ness from the record', () => {
		const normalized = normalizeFestival(record(), '2026-01-01');

		expect(normalized.prefix).toBe('test26-');
		expect(normalized.subtitle).toBe('Testville · July 17–20');
		expect(normalized.past).toBe(false);
	});

	it('is past once today is after the end date', () => {
		expect(normalizeFestival(record(), '2026-07-21').past).toBe(true);
	});

	it('is not yet past on the end date itself', () => {
		expect(normalizeFestival(record(), '2026-07-20').past).toBe(false);
	});

	it('marks a festival as happening now when today falls within its dates', () => {
		expect(normalizeFestival(record(), '2026-07-18').happeningNow).toBe(true);
	});

	it('marks a festival as happening on its start date', () => {
		expect(normalizeFestival(record(), '2026-07-17').happeningNow).toBe(true);
	});

	it('marks a festival as happening on its end date', () => {
		expect(normalizeFestival(record(), '2026-07-20').happeningNow).toBe(true);
	});

	it('marks a festival as not happening before its start date', () => {
		expect(normalizeFestival(record(), '2026-07-16').happeningNow).toBe(false);
	});

	it('marks a festival as not happening after its end date', () => {
		expect(normalizeFestival(record(), '2026-07-21').happeningNow).toBe(false);
	});
});

describe('getFestivalByPrefix', () => {
	it('resolves a room id to its festival', () => {
		expect(getFestivalByPrefix('tmr26-abc123')?.id).toBe('tmr26');
	});

	it('returns null for a custom room name', () => {
		expect(getFestivalByPrefix('birthday-party')).toBeNull();
	});
});

describe('getFestivalById', () => {
	it('resolves a bare festival id', () => {
		expect(getFestivalById('ps26')?.id).toBe('ps26');
	});

	it('does not resolve a room id', () => {
		expect(getFestivalById('ps26-abc123')).toBeNull();
	});
});

describe('isFestivalBrowseId', () => {
	it('recognises a bare festival id as a browse route', () => {
		expect(isFestivalBrowseId('tmr26')).toBe(true);
	});

	it('does not treat a joinable room as a browse route', () => {
		expect(isFestivalBrowseId('tmr26-abc123')).toBe(false);
	});
});

describe('getLatestFestival', () => {
	it('prefers an upcoming festival over a past one', () => {
		const soonUpcoming = normalizeFestival(
			record({ id: 'soon', startDate: '2026-08-01', endDate: '2026-08-03' }),
			'2026-01-01'
		);
		const longPast = normalizeFestival(
			record({ id: 'old', startDate: '2020-01-01', endDate: '2020-01-03' }),
			'2026-01-01'
		);

		expect(getLatestFestival([longPast, soonUpcoming]).id).toBe('soon');
	});

	it('picks the furthest-out end date among several upcoming festivals', () => {
		const sooner = normalizeFestival(
			record({ id: 'sooner', startDate: '2026-08-01', endDate: '2026-08-03' }),
			'2026-01-01'
		);
		const later = normalizeFestival(
			record({ id: 'later', startDate: '2026-09-01', endDate: '2026-09-03' }),
			'2026-01-01'
		);

		expect(getLatestFestival([sooner, later]).id).toBe('later');
	});

	it('falls back to the most-recently-finished festival when everything is past', () => {
		const older = normalizeFestival(
			record({ id: 'older', startDate: '2020-01-01', endDate: '2020-01-03' }),
			'2026-01-01'
		);
		const recent = normalizeFestival(
			record({ id: 'recent', startDate: '2025-01-01', endDate: '2025-01-03' }),
			'2026-01-01'
		);

		expect(getLatestFestival([older, recent]).id).toBe('recent');
	});

	it('throws on an empty list', () => {
		expect(() => getLatestFestival([])).toThrow();
	});

	it('defaults to the live festival list', () => {
		expect(() => getLatestFestival()).not.toThrow();
	});
});

describe('compareFestivalsForLanding', () => {
	it('sorts upcoming festivals before past ones', () => {
		const upcoming = normalizeFestival(record({ id: 'up' }), '2020-01-01');
		const past = normalizeFestival(record({ id: 'gone' }), '2027-01-01');

		expect([past, upcoming].sort(compareFestivalsForLanding).map((f) => f.id)).toEqual([
			'up',
			'gone'
		]);
	});

	it('sorts upcoming festivals by soonest start date', () => {
		const later = normalizeFestival(
			record({ id: 'later', startDate: '2026-09-01', endDate: '2026-09-03' }),
			'2026-01-01'
		);
		const sooner = normalizeFestival(
			record({ id: 'sooner', startDate: '2026-08-01', endDate: '2026-08-03' }),
			'2026-01-01'
		);

		expect([later, sooner].sort(compareFestivalsForLanding).map((f) => f.id)).toEqual([
			'sooner',
			'later'
		]);
	});

	it('sorts past festivals by most recently finished', () => {
		const older = normalizeFestival(
			record({ id: 'older', startDate: '2020-01-01', endDate: '2020-01-03' }),
			'2026-01-01'
		);
		const recent = normalizeFestival(
			record({ id: 'recent', startDate: '2025-01-01', endDate: '2025-01-03' }),
			'2026-01-01'
		);

		expect([older, recent].sort(compareFestivalsForLanding).map((f) => f.id)).toEqual([
			'recent',
			'older'
		]);
	});
});

describe('loadFestivals', () => {
	const originalIds = FESTIVALS.map((f) => f.id);

	beforeEach(() => {
		FESTIVALS.splice(0, FESTIVALS.length, ...DEFAULT_FESTIVALS.map((r) => normalizeFestival(r)));
	});

	it('replaces the live list with the fetched, normalized records', async () => {
		const fetched = [record({ id: 'fetched26' })];
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => fetched });

		await loadFestivals(fetchMock);

		expect(fetchMock).toHaveBeenCalledWith(FESTIVAL_DATA_PATH, { cache: 'no-store' });
		expect(FESTIVALS.map((f) => f.id)).toEqual(['fetched26']);
		expect(FESTIVALS[0]?.prefix).toBe('fetched26-');
	});

	it('leaves the list untouched on a failed response', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => [] });

		await loadFestivals(fetchMock);

		expect(FESTIVALS.map((f) => f.id)).toEqual(originalIds);
	});

	it('leaves the list untouched when the network throws', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'));

		await loadFestivals(fetchMock);

		expect(FESTIVALS.map((f) => f.id)).toEqual(originalIds);
	});

	it('leaves the list untouched on malformed JSON records', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ id: 'x' }] });

		await loadFestivals(fetchMock);

		expect(FESTIVALS.map((f) => f.id)).toEqual(originalIds);
	});

	it('leaves the list untouched on an empty array', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });

		await loadFestivals(fetchMock);

		expect(FESTIVALS.map((f) => f.id)).toEqual(originalIds);
	});
});

describe('ensureFestivalsLoaded', () => {
	beforeEach(() => {
		FESTIVALS.splice(0, FESTIVALS.length, ...DEFAULT_FESTIVALS.map((r) => normalizeFestival(r)));
	});

	it('dedupes concurrent callers onto a single fetch', async () => {
		const fetched = [record({ id: 'fetched26' })];
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => fetched });

		await Promise.all([ensureFestivalsLoaded(fetchMock), ensureFestivalsLoaded(fetchMock)]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(FESTIVALS.map((f) => f.id)).toEqual(['fetched26']);
	});

	it('re-arms after settling, so a later call refetches', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [record()] });

		await ensureFestivalsLoaded(fetchMock);
		await ensureFestivalsLoaded(fetchMock);

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
