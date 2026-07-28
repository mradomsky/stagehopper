/**
 * @file Shared StageHopper domain types.
 */

/** How strongly the viewer marked a performance: unmarked / going / maybe. */
export type SelectionState = 0 | 1 | 2;

/** A performance id → selection state map, as stored per participant. */
export type SelectionMap = Record<string, SelectionState>;

/** Which panel the room page is showing. */
export type ViewMode = 'full' | 'picks' | 'liked';

/**
 * A festival as stored in `data/festivals.json` and edited by the admin form. `id` is
 * write-once: every room id permanently embeds it as a prefix, so changing an existing
 * one would orphan every room already created under it.
 */
export interface FestivalRecord {
	id: string;
	name: string;
	location: string;
	/** ISO date, e.g. `2026-07-17`. */
	startDate: string;
	/** ISO date, e.g. `2026-07-20`. */
	endDate: string;
	/** CSS background used for the landing page card cover. */
	accent: string;
	emoji: string;
	imageUrl?: string;
}

/**
 * A festival ready for display: a {@link FestivalRecord} plus the fields derived from
 * it, so every consumer reads one flat shape regardless of whether it needs the raw
 * data (the admin form) or the derived text (the landing page).
 */
export interface Festival extends FestivalRecord {
	/** Room id prefix, e.g. `tmr26-`. `${id}-`; stored `prefix` would be pure duplication. */
	prefix: string;
	/** `location · <formatted date range>` — text can never contradict the dates. */
	subtitle: string;
	/** `today > endDate`. Past festivals are still browsable. */
	past: boolean;
}

/** One artist entry as delivered by a festival's lineup feed. */
export interface Artist {
	id?: string;
	name?: string;
	image?: string;
	instagram?: string;
	spotify?: string;
	website?: string;
	youtube?: string;
	facebook?: string;
	tiktok?: string;
	soundcloud?: string;
	twitter?: string;
}

/** A single slot on the timetable, normalized across festival feed formats. */
export interface Performance {
	id: string;
	artist: string;
	stage: string;
	/** HH:MM local festival time. */
	startTime: string;
	/** HH:MM local festival time; may be past midnight. */
	endTime: string;
	artists?: Artist[];
	artistImage?: string;
	instagram?: string;
}

export interface TimetableDay {
	/** ISO date, e.g. `2026-07-17`. */
	date: string;
	/** Human label, e.g. `Friday, July 17`. */
	label: string;
	performances: Performance[];
}

export interface Timetable {
	festival: string;
	days: TimetableDay[];
}

/** A day within an imported timetable file — no `label`, that's derived on display. */
export interface TimetableImportDay {
	/** ISO date, e.g. `2026-07-17`. */
	date: string;
	performances: Performance[];
}

/**
 * The canonical import/storage format for a festival's timetable, at
 * `data/timetable-{festivalId}.json`. One shape, versioned — import accepts nothing
 * else, so per-festival feed adapters never re-enter the app.
 */
export interface TimetableImport {
	formatVersion: 1;
	festivalId: string;
	days: TimetableImportDay[];
}

/** One participant's picks in a room, as returned by the backend. */
export interface RoomSelection {
	userId: string;
	name: string;
	color: string;
	selections: SelectionMap;
}

/** A room the signed-in user has joined, from the memberships table. */
export interface RoomMembership {
	roomId: string;
	name: string;
	color: string;
	updatedAt: number;
}

/** The signed-in Google identity, as cached client-side. */
export interface GoogleIdentity {
	idToken: string;
	sub: string;
	name: string;
	givenName: string;
}

/** One participant's mark on a specific performance, ready to render. */
export interface ParticipantMark {
	userId: string;
	name: string;
	color: string;
	state: SelectionState;
}

/** A stage plus the performances it hosts on the day being viewed. */
export interface StageWithPerformances {
	name: string;
	performances: Performance[];
}

/** A liked performance flattened with the day it belongs to. */
export interface LikedPerformance {
	id: string;
	artist: string;
	stage: string;
	startTime: string;
	endTime: string;
	date: string;
	dayLabel: string;
}
