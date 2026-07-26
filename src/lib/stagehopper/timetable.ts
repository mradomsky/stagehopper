/**
 * @file Loading and normalizing festival timetables.
 *
 * Each festival publishes its lineup in its own shape. Everything downstream of this
 * module works on the normalized {@link Timetable} type only.
 */

import primaryTimetable from './timetable.json';
import tomorrowlandRaw from './timetable-tmr26.json';
import { getFestivalById, getFestivalByPrefix, getLatestFestival } from './festivals.js';
import type {
	Artist,
	LikedPerformance,
	Performance,
	StageWithPerformances,
	Timetable,
	TimetableDay
} from './types.js';

/** Tomorrowland's feed: a flat performance list with nested stage/artist objects. */
interface TomorrowlandRawPerformance {
	id?: string;
	name?: string;
	artists?: Artist[];
	stage?: { id?: string; name?: string };
	date?: string;
	day?: string;
	/** Full timestamp with offset, e.g. `2026-07-19 00:00:00+02:00`. */
	startTime?: string;
	endTime?: string;
}

interface TomorrowlandRawTimetable {
	festival?: string;
	performances?: TomorrowlandRawPerformance[];
}

/** Extract HH:MM from a timestamp like `2026-07-19 00:00:00+02:00`. */
function extractTimeFromTimestamp(value: string): string {
	const match = value.match(/(\d{2}):(\d{2}):/);
	if (!match) return '00:00';
	return `${match[1]}:${match[2]}`;
}

/** Format an ISO date as `Friday, July 17`. */
function formatDateLabel(dateStr: string): string {
	const date = new Date(`${dateStr}T00:00:00Z`);
	return new Intl.DateTimeFormat('en-US', {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		timeZone: 'UTC'
	}).format(date);
}

function normalizeTomorrowland(raw: TomorrowlandRawTimetable): Timetable {
	const performancesByDate = new Map<string, TomorrowlandRawPerformance[]>();
	for (const performance of raw.performances ?? []) {
		const date = performance.date ?? '';
		const bucket = performancesByDate.get(date);
		if (bucket) bucket.push(performance);
		else performancesByDate.set(date, [performance]);
	}

	const days: TimetableDay[] = [...performancesByDate.entries()]
		.sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
		.map(([date, performances]) => ({
			date,
			label: formatDateLabel(date),
			performances: performances
				.map((performance): Performance => {
					const firstArtist = performance.artists?.[0];
					return {
						id: performance.id ?? '',
						artist: performance.name ?? '',
						stage: performance.stage?.name ?? '',
						startTime: extractTimeFromTimestamp(performance.startTime ?? ''),
						endTime: extractTimeFromTimestamp(performance.endTime ?? ''),
						...(performance.artists && { artists: performance.artists }),
						...(firstArtist?.image && { artistImage: firstArtist.image }),
						...(firstArtist?.instagram && { instagram: firstArtist.instagram })
					};
				})
				.sort((a, b) => a.startTime.localeCompare(b.startTime))
		}));

	return { festival: raw.festival ?? 'Tomorrowland', days };
}

/**
 * Normalize timetable data to the internal format.
 * Primavera (`ps26`) is authored pre-normalized; Tomorrowland (`tmr26`) is converted
 * from its raw feed. Unknown festivals are passed through unchanged.
 */
export function normalizeTimetable(rawTimetable: unknown, festivalId: string): Timetable {
	if (festivalId === 'tmr26') {
		return normalizeTomorrowland((rawTimetable ?? {}) as TomorrowlandRawTimetable);
	}
	return (rawTimetable ?? { festival: '', days: [] }) as Timetable;
}

/**
 * The timetable to show for a room id, which may be a joinable room (`tmr26-abc123`)
 * or a bare festival browse id (`tmr26`). Falls back to the latest festival.
 */
export function getTimetableForRoom(roomId: string): Timetable {
	const festival =
		getFestivalById(roomId) ?? getFestivalByPrefix(roomId) ?? getLatestFestival();
	if (festival.id === 'tmr26') {
		return normalizeTimetable(tomorrowlandRaw, 'tmr26');
	}
	return normalizeTimetable(primaryTimetable, festival.id);
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
