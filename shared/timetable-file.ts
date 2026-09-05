/**
 * @file The shape of a published timetable file, `data/festivals/{id}/timetable.json`.
 *
 * Three consumers read or write this file and each used to declare its own view of it: the
 * API Lambda builds it, the notifier flattens it to decide who to wake, and the SPA parses
 * it into the display model. Nothing connected those declarations, so a field added to the
 * writer reached the readers only if someone remembered — the same shape of bug as the
 * festivals manifest in CLAUDE.md trap 3, minus the whitelist that made that one visible.
 *
 * Deliberately not here: the *upload* payload the admin importer validates. That types the
 * same fields as `unknown` because it describes untrusted input rather than a file this
 * system wrote, and collapsing the two would lose that distinction.
 *
 * No runtime dependencies: this file bundles into two Lambdas and the browser.
 */

/** The optional string fields a performance may carry, as one list both sides can iterate. */
export const PERFORMANCE_OPTIONAL_STRING_FIELDS = [
	'artistImage',
	'instagram',
	'spotify',
	'youtube',
	'soundcloud'
] as const;

export type PerformanceOptionalStringField = (typeof PERFORMANCE_OPTIONAL_STRING_FIELDS)[number];

/** One set: an artist on a stage between two wall-clock times on a day. */
export interface PublishedPerformance extends Partial<Record<PerformanceOptionalStringField, string>> {
	/** Assigned by the importer, never by the uploaded file. */
	id: string;
	artist: string;
	stage: string;
	/** HH:MM local festival time. */
	startTime: string;
	/** HH:MM local festival time; may be past midnight. */
	endTime: string;
	/**
	 * Per-artist lineup enrichment from the import feed. Deliberately `unknown`: the importer
	 * passes whatever the feed carried straight through without validating it, so a reader
	 * that wants structure has to narrow. Claiming a shape here would be claiming a check
	 * nothing performs.
	 */
	artists?: unknown;
}

/**
 * A day of the published timetable. No `label` — that is derived on display, so it exists in
 * the SPA's model and never in the file.
 */
export interface PublishedDay {
	/** ISO date, e.g. `2026-07-17`. */
	date: string;
	performances: PublishedPerformance[];
}

/** The file itself. */
export interface PublishedTimetable {
	formatVersion: 1;
	festivalId: string;
	days: PublishedDay[];
}
