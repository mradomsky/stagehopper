/**
 * @file Shared StageHopper domain types.
 */

/** How strongly the viewer marked a performance: unmarked / going / maybe. */
export type SelectionState = 0 | 1 | 2;

/** A performance id → selection state map, as stored per participant. */
export type SelectionMap = Record<string, SelectionState>;

/**
 * Which panel the room page is showing. The eye in the timetable corner (see
 * {@link RoomState.picksOnly}) is a separate, unrelated filter over the full timetable.
 */
export type ViewMode = 'full' | 'picks';

/**
 * A festival as stored in `stagehopper-festivals` (DynamoDB) and edited by the admin form. `id` is
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
	/** IANA timezone, e.g. `Europe/Berlin`. Required on write; legacy records default to `Europe/Berlin` on read. */
	timezone?: string;
	/** Cover image for the landing card. Absent falls back to a neutral placeholder. */
	imageUrl?: string;
	/** Uploaded festival map image. Absent hides the Map tab. */
	mapUrl?: string;
	/** Plain text, shown on the festival detail page. Max 1000 characters. */
	description?: string;
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
	/** `startDate <= today <= endDate`. Festival is currently happening. */
	happeningNow: boolean;
}

/** One artist entry as delivered by a festival's lineup feed. */
export interface Artist {
	id?: string;
	name?: string;
	image?: string;
	/** Plain-text bio; feed HTML is stripped at import time. */
	bio?: string;
	/** Genre labels, e.g. `['Indie Rock', 'Pop']`. */
	genres?: string[];
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
 * `stagehopper-performances` (DynamoDB), republished to `data/festivals/{festivalId}/timetable.json`.
 * One shape, versioned — import accepts nothing
 * else, so per-festival feed adapters never re-enter the app.
 */
export interface TimetableImport {
	formatVersion: 1;
	festivalId: string;
	days: TimetableImportDay[];
}

/**
 * A performance as given in an uploaded timetable file — no `id`. The importer assigns
 * one (random hex, matching the room id pattern): requiring the file to supply unique
 * ids makes every upload responsible for an invariant it has no way to guarantee, and a
 * feed that reuses or omits ids would silently corrupt selections keyed on them.
 */
export type TimetableUploadPerformance = Omit<Performance, 'id'>;

export interface TimetableUploadDay {
	/** ISO date, e.g. `2026-07-17`. */
	date: string;
	performances: TimetableUploadPerformance[];
}

/** The shape a timetable import file is validated against, before ids are assigned. */
export interface TimetableUpload {
	formatVersion: 1;
	festivalId: string;
	days: TimetableUploadDay[];
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

/**
 * An opaque DynamoDB pagination cursor. The admin list endpoints scan one page and hand this
 * back verbatim; the client echoes it as `startKey` to fetch the next. Its shape is the table's
 * key attributes — never inspected client-side, only passed through.
 */
export type PageCursor = Record<string, unknown>;

/**
 * One room in the admin browser — the aggregate of its membership rows. `festivalName` isn't
 * stored; the page derives it from the room id prefix. Partial per scanned page, merged by id.
 */
export interface AdminRoomSummary {
	roomId: string;
	participantCount: number;
	updatedAt: number;
}

/** One user in the admin browser — the aggregate of their membership rows across rooms. */
export interface AdminUserSummary {
	userId: string;
	name: string;
	/** Email from the caller's token claims; '' for a user whose account carries none. */
	email: string;
	roomCount: number;
	lastActive: number;
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

