/**
 * @file Loading and rendering festival timetables.
 *
 * Every festival's timetable lives at `data/timetable-{festivalId}.json` in the
 * canonical v1 format (see {@link TimetableImport} in types.ts) — fetched at runtime,
 * not bundled. There is no per-festival adapter here any more: import is the boundary
 * where a raw feed becomes this shape, once, and nothing downstream ever sees the raw
 * feed again.
 */

import { getFestivalById, getFestivalByPrefix, getLatestFestival } from './festivals.svelte.js';
import type {
	LikedPerformance,
	Performance,
	StageWithPerformances,
	Timetable,
	TimetableDay,
	TimetableImportDay
} from './types.js';

/** Public path a festival's stored timetable is served from. */
export function timetableDataPath(festivalId: string): string {
	return `/data/timetable-${festivalId}.json`;
}

/** Format an ISO date as `Friday, July 17`. */
export function formatDateLabel(dateStr: string): string {
	const date = new Date(`${dateStr}T00:00:00Z`);
	return new Intl.DateTimeFormat('en-US', {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		timeZone: 'UTC'
	}).format(date);
}

/** Attach the display `label` derived from each day's date — the file never stores one. */
export function toDisplayTimetable(festivalName: string, days: TimetableImportDay[]): Timetable {
	return {
		festival: festivalName,
		days: days.map((day): TimetableDay => ({ ...day, label: formatDateLabel(day.date) }))
	};
}

/**
 * A light shape check on a fetched timetable payload — not the full import validator
 * (that only matters at write time; the Lambda already enforced it there). This just
 * guards against a truncated fetch or a stale/malformed cached response crashing the room.
 */
function isPlausibleTimetablePayload(value: unknown): value is { days: TimetableImportDay[] } {
	if (!value || typeof value !== 'object') return false;
	const days = (value as { days?: unknown }).days;
	return Array.isArray(days);
}

export type TimetableFetchResult = { ok: true; data: Timetable } | { ok: false };

async function fetchTimetableDays(
	festivalId: string,
	fetchImpl: typeof fetch
): Promise<TimetableImportDay[] | null> {
	try {
		const response = await fetchImpl(timetableDataPath(festivalId));
		if (!response.ok) return null;

		const parsed: unknown = await response.json();
		if (!isPlausibleTimetablePayload(parsed)) return null;

		return parsed.days;
	} catch {
		return null;
	}
}

/**
 * Fetch and normalize the timetable for a room id, which may be a joinable room
 * (`tmr26-abc123`) or a bare festival browse id (`tmr26`). Falls back to the latest
 * festival when the id doesn't resolve to one.
 */
export async function fetchTimetableForRoom(
	roomId: string,
	fetchImpl: typeof fetch = fetch
): Promise<TimetableFetchResult> {
	const festival = getFestivalById(roomId) ?? getFestivalByPrefix(roomId) ?? getLatestFestival();
	const days = await fetchTimetableDays(festival.id, fetchImpl);
	return days ? { ok: true, data: toDisplayTimetable(festival.name, days) } : { ok: false };
}

/**
 * Fetch and normalize a festival's timetable directly by id — for the admin editor,
 * which already knows exactly which festival it's editing and has no room to resolve.
 */
export async function fetchTimetableForFestival(
	festivalId: string,
	festivalName: string,
	fetchImpl: typeof fetch = fetch
): Promise<TimetableFetchResult> {
	const days = await fetchTimetableDays(festivalId, fetchImpl);
	return days ? { ok: true, data: toDisplayTimetable(festivalName, days) } : { ok: false };
}

/**
 * Stage display order: first appearance across the whole festival, so columns stay
 * in the same order when switching days.
 */
export function buildStageOrder(timetable: Timetable): string[] {
	const order: string[] = [];
	const seen = new Set<string>();
	for (const day of timetable.days ?? []) {
		for (const performance of day.performances ?? []) {
			if (!seen.has(performance.stage)) {
				seen.add(performance.stage);
				order.push(performance.stage);
			}
		}
	}
	return order;
}

/**
 * Reorder stages so the viewer's favourites come first, each group keeping its
 * original left-to-right order. Names not in the timetable order are ignored.
 */
export function orderStagesByFavourite(
	stageOrder: string[],
	favouriteStages: ReadonlySet<string>
): string[] {
	if (favouriteStages.size === 0) return stageOrder;
	const favourites = stageOrder.filter((name) => favouriteStages.has(name));
	const rest = stageOrder.filter((name) => !favouriteStages.has(name));
	return [...favourites, ...rest];
}

/** Group one day's performances into stage columns, dropping stages with nothing on. */
export function groupPerformancesByStage(
	day: TimetableDay | undefined,
	stageOrder: string[]
): StageWithPerformances[] {
	const byStage = new Map<string, Performance[]>();
	for (const performance of day?.performances ?? []) {
		const bucket = byStage.get(performance.stage);
		if (bucket) bucket.push(performance);
		else byStage.set(performance.stage, [performance]);
	}
	return stageOrder
		.map((name) => ({ name, performances: byStage.get(name) ?? [] }))
		.filter((stage) => stage.performances.length > 0);
}

/** Flatten every liked performance across the festival, in chronological order. */
export function collectLikedPerformances(
	timetable: Timetable,
	likedIds: ReadonlySet<string>
): LikedPerformance[] {
	const result: LikedPerformance[] = [];
	for (const day of timetable.days ?? []) {
		for (const performance of day.performances ?? []) {
			if (likedIds.has(performance.id)) {
				result.push({
					id: performance.id,
					artist: performance.artist,
					stage: performance.stage,
					startTime: performance.startTime,
					endTime: performance.endTime,
					date: day.date,
					dayLabel: day.label
				});
			}
		}
	}
	return result.sort(
		(a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime)
	);
}
