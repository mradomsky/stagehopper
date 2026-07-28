/**
 * @file StageHopper festival configuration.
 *
 * The list is data, not code: it lives in `data/festivals.json` in S3, editable by an
 * admin at runtime (#34). `FESTIVALS` starts seeded with {@link DEFAULT_FESTIVALS} so the
 * app has something to render before the fetch resolves (or if it never does — a bad
 * network beats a blank landing page), then {@link loadFestivals} swaps in the live data.
 * It's `$state` so every consumer re-renders the moment that swap happens, with no need
 * to thread a loading state through call sites that only ever read the array directly.
 */

import { localIsoDate } from './time.js';
import type { Festival, FestivalRecord } from './types.js';

/** Where the live festival list is published, relative to the site origin. */
export const FESTIVAL_DATA_PATH = '/data/festivals.json';

/**
 * The compiled fallback: what every visitor sees until `data/festivals.json` exists in
 * S3 for real. `deploy.yml` excludes `data/*` from its sync so a deploy never clobbers
 * an admin's edits — which also means nothing ever seeds that object automatically.
 * The first `PUT /api/stagehopper/admin/festivals` creates it; before that, this array
 * IS the live list, identical in content, just served from the bundle instead of S3.
 */
export const DEFAULT_FESTIVALS: FestivalRecord[] = [
	{
		id: 'tmr26',
		name: 'Tomorrowland 2026 – Week 1',
		location: 'Boom, Belgium',
		startDate: '2026-07-17',
		endDate: '2026-07-20',
		accent: 'linear-gradient(135deg, #ff9a56, #ff6b6b 55%, #c44569)',
		emoji: '🎪'
	},
	{
		id: 'ps26',
		name: 'Primavera Sound Barcelona 2026',
		location: 'Barcelona',
		startDate: '2026-06-04',
		endDate: '2026-06-06',
		accent: 'linear-gradient(135deg, #4facfe, #6c5ce7)',
		emoji: '🌊'
	}
];

const MONTH_NAMES = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December'
];

/** Parse an ISO `YYYY-MM-DD` into its calendar parts, without any timezone conversion. */
function parseIsoDate(iso: string): { year: number; month: number; day: number } {
	const [year, month, day] = iso.split('-').map(Number);
	return { year: year ?? 0, month: month ?? 1, day: day ?? 1 };
}

/**
 * Render a festival's date span as the single line the landing card shows, e.g.
 * `July 17–20` within a month, or `June 28 – July 2` across one.
 */
export function formatDateRange(startDate: string, endDate: string): string {
	const start = parseIsoDate(startDate);
	const end = parseIsoDate(endDate);
	const startMonth = MONTH_NAMES[start.month - 1] ?? '';
	const endMonth = MONTH_NAMES[end.month - 1] ?? '';

	if (start.year === end.year && start.month === end.month) {
		return `${startMonth} ${start.day}–${end.day}`;
	}
	if (start.year === end.year) {
		return `${startMonth} ${start.day} – ${endMonth} ${end.day}`;
	}
	return `${startMonth} ${start.day}, ${start.year} – ${endMonth} ${end.day}, ${end.year}`;
}

/** Attach the fields derived from a stored record: `prefix`, `subtitle`, `past`. */
export function normalizeFestival(record: FestivalRecord, today: string = localIsoDate()): Festival {
	return {
		...record,
		prefix: `${record.id}-`,
		subtitle: `${record.location} · ${formatDateRange(record.startDate, record.endDate)}`,
		past: today > record.endDate
	};
}

/**
 * The live festival list. Reactive so every component re-renders once {@link loadFestivals}
 * replaces it — mutated in place, never reassigned, so this binding stays the one every
 * module imported.
 */
export const FESTIVALS: Festival[] = $state(DEFAULT_FESTIVALS.map((record) => normalizeFestival(record)));

function isFestivalRecord(value: unknown): value is FestivalRecord {
	if (!value || typeof value !== 'object') return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === 'string' &&
		typeof record.name === 'string' &&
		typeof record.location === 'string' &&
		typeof record.startDate === 'string' &&
		typeof record.endDate === 'string' &&
		typeof record.accent === 'string' &&
		typeof record.emoji === 'string' &&
		(record.imageUrl === undefined || typeof record.imageUrl === 'string')
	);
}

/**
 * Fetch the live festival list and swap it in. Errors of every kind — network, bad
 * JSON, a malformed record — are swallowed and leave {@link FESTIVALS} exactly as it
 * was: the landing page degrading to the compiled defaults beats it rendering nothing.
 */
export async function loadFestivals(fetchImpl: typeof fetch = fetch): Promise<void> {
	try {
		const response = await fetchImpl(FESTIVAL_DATA_PATH);
		if (!response.ok) return;
		const parsed: unknown = await response.json();
		if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isFestivalRecord)) return;

		const normalized = parsed.map((record) => normalizeFestival(record));
		FESTIVALS.splice(0, FESTIVALS.length, ...normalized);
	} catch {
		// Network failure, invalid JSON — leave the seeded defaults in place.
	}
}

/** Find the festival a room id belongs to, by its id prefix. */
export function getFestivalByPrefix(roomId: string): Festival | null {
	return FESTIVALS.find((f) => roomId.startsWith(f.prefix)) ?? null;
}

/** Find festival by exact id — used for guest browse routes, which are bare festival ids. */
export function getFestivalById(id: string): Festival | null {
	return FESTIVALS.find((f) => f.id === id) ?? null;
}

/**
 * True when the given room id is really a festival browse id (`/tmr26`) rather than
 * a joinable room (`/tmr26-abc123`). Browsing is read-only and needs no sign-in.
 */
export function isFestivalBrowseId(roomId: string): boolean {
	return FESTIVALS.some((f) => f.id === roomId);
}

/**
 * The festival new rooms/timetables default to when nothing else specifies one: the
 * one with the furthest-out end date, preferring an upcoming festival over a past one.
 */
export function getLatestFestival(festivals: readonly Festival[] = FESTIVALS): Festival {
	if (festivals.length === 0) {
		throw new Error('festivals must not be empty');
	}
	const upcoming = festivals.filter((f) => !f.past);
	const pool = upcoming.length > 0 ? upcoming : festivals;
	return pool.reduce((latest, f) => (f.endDate > latest.endDate ? f : latest));
}

/**
 * Landing page order: upcoming festivals first (soonest first), then past festivals
 * (most recently finished first) — array order stops being meaningful once the list is
 * admin-editable data instead of a curated constant.
 */
export function compareFestivalsForLanding(a: Festival, b: Festival): number {
	if (a.past !== b.past) return a.past ? 1 : -1;
	return a.past ? b.endDate.localeCompare(a.endDate) : a.startDate.localeCompare(b.startDate);
}
