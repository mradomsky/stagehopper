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

/** Valid lead times (minutes before a performance) for notifications. */
export const LEAD_OPTIONS = [5, 10, 15, 20, 30];

/**
 * Check if a lead time is in the valid set.
 */
export function isValidLead(n: unknown): boolean {
	return typeof n === 'number' && LEAD_OPTIONS.includes(n);
}

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
