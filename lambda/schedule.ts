/**
 * @file Pure scheduling logic for push notifications.
 * Dependency-free, fully unit-testable.
 */

/**
 * Clock time (in minutes) at which one festival day rolls over to the next.
 * Mirrors src/lib/stagehopper/time.ts — festival day rolls over at 09:00;
 * sets before it are post-midnight (next calendar day).
 */
export const DAY_BOUNDARY_MIN = 9 * 60;

/**
 * Determine the effective date for a performance.
 * Times before DAY_BOUNDARY_MIN roll to the next calendar day.
 *
 * @param dayDate ISO date string (YYYY-MM-DD) from the timetable
 * @param startTime HH:MM time string
 * @returns ISO date string: dayDate + 1 if startTime < 09:00, else dayDate
 */
export function effectiveDate(dayDate: string, startTime: string): string {
	const timeParts = startTime.split(':');
	const hours = Number(timeParts[0]) || 0;
	const minutes = Number(timeParts[1]) || 0;
	const timeInMinutes = hours * 60 + minutes;

	if (timeInMinutes < DAY_BOUNDARY_MIN) {
		// Roll forward to next calendar day
		const d = new Date(dayDate + 'T00:00:00Z');
		d.setUTCDate(d.getUTCDate() + 1);
		const isoStr = d.toISOString();
		const datePart = isoStr.split('T')[0];
		return datePart || dayDate;
	}
	return dayDate;
}

/**
 * The signed UTC offset (ms) a timezone is at a given instant: `localAsUtc - utcMs`.
 *
 * Formats the instant in the zone, reads the wall-clock fields back as if they were UTC,
 * and diffs. Reading the *whole* date (not just the hour) makes it correct for zones west
 * of UTC — where the instant lands on a different calendar day — and for half-hour zones.
 */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	}).formatToParts(new Date(utcMs));

	const field = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
	// `hour` can come back as 24 at midnight in some engines — modulo keeps Date.UTC sane.
	const asUtc = Date.UTC(
		field('year'),
		field('month') - 1,
		field('day'),
		field('hour') % 24,
		field('minute'),
		field('second')
	);
	return asUtc - utcMs;
}

/**
 * Convert a wall-clock time in a given timezone to UTC milliseconds (epoch).
 *
 * Interprets the target time as if it were UTC, then corrects by the zone's offset *at
 * that instant* — so it stays right across DST boundaries and for zones on either side of
 * UTC. Sampling the offset at the target time (not at midnight) is what fixes the
 * DST-transition-night case.
 *
 * @param isoDate ISO date string (YYYY-MM-DD)
 * @param hhmm Time string (HH:MM)
 * @param timeZone IANA timezone name
 * @returns Epoch milliseconds (UTC)
 */
export function zonedWallClockToUtcMs(isoDate: string, hhmm: string, timeZone: string): number {
	const timeParts = hhmm.split(':');
	const targetHours = Number(timeParts[0]) || 0;
	const targetMinutes = Number(timeParts[1]) || 0;

	// The target wall-clock reading, treated as if it were already UTC.
	const guessMs = new Date(
		`${isoDate}T${String(targetHours).padStart(2, '0')}:${String(targetMinutes).padStart(2, '0')}:00Z`
	).getTime();

	// One correction is exact except within the ~1h DST gap/overlap; a second pass using
	// the corrected instant's offset settles those. (Both offsets agree away from the seam.)
	const firstOffset = zoneOffsetMs(guessMs, timeZone);
	const secondOffset = zoneOffsetMs(guessMs - firstOffset, timeZone);
	return guessMs - secondOffset;
}

/**
 * Convert a performance's day date and start time to UTC epoch milliseconds.
 * Accounts for the effective date rollover rule (times before 09:00 go to next day).
 *
 * @param dayDate ISO date from timetable
 * @param startTime HH:MM time
 * @param timeZone IANA timezone for the festival
 * @returns Epoch milliseconds
 */
export function performanceStartUtcMs(dayDate: string, startTime: string, timeZone: string): number {
	const effDate = effectiveDate(dayDate, startTime);
	return zonedWallClockToUtcMs(effDate, startTime, timeZone);
}

/**
 * Calculate when to send a notification for a performance.
 *
 * @param perfStartUtcMs Performance start time in epoch ms
 * @param leadMinutes Lead time before the performance
 * @returns Epoch ms for when to send
 */
export function sendAtMs(perfStartUtcMs: number, leadMinutes: number): number {
	return perfStartUtcMs - leadMinutes * 60_000;
}

/**
 * Check if a send time is due within the given window.
 *
 * @param sendAtMs When the notification should have been sent
 * @param nowMs Current time (epoch ms)
 * @param windowMs Time window to check (default 3 minutes)
 * @returns true if sendAtMs is in (nowMs - windowMs, nowMs]
 */
export function isDue(sendAtMs: number, nowMs: number, windowMs: number = 3 * 60_000): boolean {
	return sendAtMs > nowMs - windowMs && sendAtMs <= nowMs;
}

/**
 * Check if a send time is within the candidate window (worth considering for notification).
 * Performance starts should be within [now - 3min, now + 30min + 3min].
 *
 * @param perfStartUtcMs Performance start time
 * @param nowMs Current time
 * @returns true if the performance is in the candidate window
 */
export function inCandidateWindow(perfStartUtcMs: number, nowMs: number): boolean {
	const lookBackMs = 3 * 60_000; // 3 minutes
	const lookAheadMs = 30 * 60_000 + 3 * 60_000; // 30 min + 3 min window
	return perfStartUtcMs >= nowMs - lookBackMs && perfStartUtcMs <= nowMs + lookAheadMs;
}

/**
 * Aggregate user's state across rooms for a single performance.
 *
 * @param states Array of SelectionState values (0=not marked, 1=attending, 2=maybe)
 * @returns Object with attending and maybe booleans
 */
export function aggregateStates(states: number[]): { attending: boolean; maybe: boolean } {
	return {
		attending: states.some((s) => s === 1),
		maybe: states.some((s) => s === 2)
	};
}

/**
 * Check if a user qualifies to receive a notification based on their selection state,
 * their "maybe" preference, and any per-performance override.
 *
 * Going always notifies; there's no toggle for it any more. Maybe only notifies when
 * `notifyMaybe` is on. An `override` — set from the bell on one specific performance —
 * replaces that default for this performance alone, but can never conjure a notification
 * for a performance the user hasn't marked (going or maybe) at all.
 *
 * @param agg Aggregated state (attending and maybe)
 * @param notifyMaybe User's preference to notify on "maybe" marks
 * @param override Per-performance override: true/false replaces the default rule, undefined uses it
 * @returns true if the user qualifies
 */
export function qualifies(
	agg: { attending: boolean; maybe: boolean },
	notifyMaybe: boolean,
	override?: boolean
): boolean {
	if (!agg.attending && !agg.maybe) return false;
	if (override !== undefined) return override;
	return agg.attending || (agg.maybe && notifyMaybe);
}

/** A set, as much of one as deciding whether to notify about it needs. */
export interface SchedulablePerformance {
	id: string;
	artist: string;
	stage: string;
	/** HH:MM local festival time. */
	startTime: string;
	/** ISO date of the festival day it is listed under. */
	dayDate: string;
}

/** One festival's candidate sets, with the zone their times are written in. */
export interface FestivalCandidates {
	festivalId: string;
	timezone: string;
	performances: SchedulablePerformance[];
}

/**
 * What one user has marked in one room, read once per tick.
 *
 * `updatedAt` breaks the tie when a set is marked in more than one room: the notification
 * taps through to a single room, and the most recently active one is the best guess at
 * which the user means.
 */
export interface RoomPicks {
	roomId: string;
	festivalId: string;
	updatedAt: number;
	/** Performance id → selection state, as stored. */
	selections: Record<string, unknown>;
}

/** The notification preferences carried on a user row. */
export interface NotifyPreferences {
	/** Minutes before the set to send. The app's own default is 15. */
	leadMinutes?: number;
	notifyMaybe?: boolean;
	/** Per-performance overrides of the default rule, keyed by performance id. */
	notifyOverrides?: Record<string, boolean>;
}

/** A set this user should be notified about now, and the room to open. */
export interface DueNotification {
	festivalId: string;
	performance: SchedulablePerformance;
	roomId: string;
	/** When the set starts, in UTC ms — the dedup key's second half. */
	perfStartMs: number;
}

const DEFAULT_LEAD_MINUTES = 15;

/**
 * Everything the notifier decides, with none of what it reads.
 *
 * This used to be three nested loops inside the handler, reachable only by running the
 * whole Lambda against a scripted sequence of DynamoDB responses — which is why a set
 * marked in two rooms, or an override on one of them, was awkward to state as a test.
 * It takes the picks already loaded rather than fetching per performance: the row holding
 * them carries every set in that room, so re-reading it per set was the same row over and
 * over, once for each candidate in the window.
 */
export function dueNotifications(
	prefs: NotifyPreferences,
	festivals: FestivalCandidates[],
	picks: RoomPicks[],
	nowMs: number
): DueNotification[] {
	const due: DueNotification[] = [];
	const leadMins = prefs.leadMinutes ?? DEFAULT_LEAD_MINUTES;

	for (const festival of festivals) {
		const roomsHere = picks.filter((pick) => pick.festivalId === festival.festivalId);
		if (roomsHere.length === 0) continue;

		for (const performance of festival.performances) {
			const states: number[] = [];
			let roomId: string | null = null;
			let bestUpdatedAt = -1;

			for (const room of roomsHere) {
				const state = room.selections[performance.id];
				if (typeof state !== 'number') continue;
				states.push(state);
				// `>=` so the last room wins a tie, matching the order rooms arrive in.
				if (room.updatedAt >= bestUpdatedAt) {
					bestUpdatedAt = room.updatedAt;
					roomId = room.roomId;
				}
			}

			// A room id is always set alongside a state, so the two agree by construction.
			if (states.length === 0 || roomId === null) continue;

			const agg = aggregateStates(states);
			if (!qualifies(agg, prefs.notifyMaybe ?? false, prefs.notifyOverrides?.[performance.id])) {
				continue;
			}

			const perfStartMs = performanceStartUtcMs(
				performance.dayDate,
				performance.startTime,
				festival.timezone
			);
			if (!isDue(sendAtMs(perfStartMs, leadMins), nowMs)) continue;

			due.push({ festivalId: festival.festivalId, performance, roomId, perfStartMs });
		}
	}

	return due;
}
