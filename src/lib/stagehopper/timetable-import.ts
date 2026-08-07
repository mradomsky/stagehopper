/**
 * @file Client-side validation and preview for a timetable import file.
 *
 * Mirrors the Lambda's rules (there's no shared module between the two — they're
 * separate projects) so a bad file is rejected before the upload round-trip, not after.
 * The Lambda re-validates the same shape regardless: the client is untrusted.
 */

import type { Artist, TimetableUpload, TimetableUploadDay, TimetableUploadPerformance } from './types.js';

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
/** Past this many collected errors, stop — a wholesale-wrong file doesn't need 4000 lines. */
const MAX_ERRORS = 50;

export interface TimetableValidationResult {
	data?: TimetableUpload;
	errors: string[];
}

export interface TimetablePreview {
	festivalId: string;
	dayCount: number;
	performanceCount: number;
	stages: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed import file against the canonical v1 format.
 *
 * `id` is not part of this shape: the importer assigns one to every performance at
 * import time (random hex, matching the room id pattern), so a file is never
 * responsible for supplying ids that are unique or even present. Any `id` field the
 * file happens to include is ignored.
 */
export function validateTimetableImport(raw: unknown): TimetableValidationResult {
	const errors: string[] = [];
	const push = (message: string) => {
		if (errors.length < MAX_ERRORS) errors.push(message);
	};

	if (!isPlainObject(raw)) {
		return { errors: ['File must contain a JSON object.'] };
	}
	if (raw.formatVersion !== 1) push('formatVersion must be 1.');
	if (typeof raw.festivalId !== 'string' || raw.festivalId.trim().length === 0) {
		push('festivalId is required.');
	}
	if (!Array.isArray(raw.days) || raw.days.length === 0) {
		push('days must be a non-empty array.');
		return { errors };
	}

	const days: TimetableUploadDay[] = [];

	raw.days.forEach((rawDay, dayIndex) => {
		const dayLabel = `Day ${dayIndex + 1}`;
		if (!isPlainObject(rawDay)) {
			push(`${dayLabel}: must be an object.`);
			return;
		}
		if (typeof rawDay.date !== 'string' || !ISO_DATE_REGEX.test(rawDay.date)) {
			push(`${dayLabel}: date must be an ISO date (YYYY-MM-DD).`);
		}
		if (!Array.isArray(rawDay.performances)) {
			push(`${dayLabel}: performances must be an array.`);
			return;
		}

		const performances: TimetableUploadPerformance[] = [];
		rawDay.performances.forEach((rawPerf, perfIndex) => {
			const label = `${dayLabel}, performance ${perfIndex + 1}`;
			if (!isPlainObject(rawPerf)) {
				push(`${label}: must be an object.`);
				return;
			}
			if (typeof rawPerf.artist !== 'string' || rawPerf.artist.trim().length === 0) {
				push(`${label}: artist is required.`);
			}
			if (typeof rawPerf.stage !== 'string' || rawPerf.stage.trim().length === 0) {
				push(`${label}: stage is required.`);
			}
			if (typeof rawPerf.startTime !== 'string' || !TIME_REGEX.test(rawPerf.startTime)) {
				push(`${label}: startTime must be HH:MM.`);
			}
			if (typeof rawPerf.endTime !== 'string' || !TIME_REGEX.test(rawPerf.endTime)) {
				push(`${label}: endTime must be HH:MM.`);
			}

			performances.push({
				artist: typeof rawPerf.artist === 'string' ? rawPerf.artist : '',
				stage: typeof rawPerf.stage === 'string' ? rawPerf.stage : '',
				startTime: typeof rawPerf.startTime === 'string' ? rawPerf.startTime : '',
				endTime: typeof rawPerf.endTime === 'string' ? rawPerf.endTime : '',
				...(Array.isArray(rawPerf.artists) && { artists: rawPerf.artists as Artist[] }),
				...(typeof rawPerf.artistImage === 'string' &&
					rawPerf.artistImage && { artistImage: rawPerf.artistImage }),
				...(typeof rawPerf.instagram === 'string' &&
					rawPerf.instagram && { instagram: rawPerf.instagram })
			});
		});

		days.push({ date: typeof rawDay.date === 'string' ? rawDay.date : '', performances });
	});

	if (errors.length > 0) return { errors };

	return {
		data: { formatVersion: 1, festivalId: raw.festivalId as string, days },
		errors: []
	};
}

/** Summary stats shown to the admin before they commit an import. */
export function buildTimetablePreview(timetable: TimetableUpload): TimetablePreview {
	const stages = new Set<string>();
	let performanceCount = 0;
	for (const day of timetable.days) {
		for (const performance of day.performances) {
			stages.add(performance.stage);
			performanceCount++;
		}
	}
	return {
		festivalId: timetable.festivalId,
		dayCount: timetable.days.length,
		performanceCount,
		stages: [...stages].sort()
	};
}
