import { describe, it, expect } from 'vitest';
import {
	DAY_BOUNDARY_MIN,
	effectiveDate,
	zonedWallClockToUtcMs,
	performanceStartUtcMs,
	sendAtMs,
	isDue,
	inCandidateWindow,
	aggregateStates,
	qualifies,
	dueNotifications,
	type FestivalCandidates,
	type RoomPicks
} from './schedule.js';

describe('schedule', () => {
	describe('constants', () => {
		it('DAY_BOUNDARY_MIN is 540 (09:00)', () => {
			expect(DAY_BOUNDARY_MIN).toBe(540);
		});
	});

	describe('effectiveDate', () => {
		it('returns same date for times >= 09:00', () => {
			expect(effectiveDate('2026-07-18', '09:00')).toBe('2026-07-18');
			expect(effectiveDate('2026-07-18', '14:30')).toBe('2026-07-18');
			expect(effectiveDate('2026-07-18', '23:59')).toBe('2026-07-18');
		});

		it('rolls to next calendar day for times < 09:00 (post-midnight)', () => {
			expect(effectiveDate('2026-07-18', '00:00')).toBe('2026-07-19');
			expect(effectiveDate('2026-07-18', '01:00')).toBe('2026-07-19');
			expect(effectiveDate('2026-07-18', '08:59')).toBe('2026-07-19');
		});

		it('handles month/year boundaries', () => {
			expect(effectiveDate('2026-07-31', '01:00')).toBe('2026-08-01');
			expect(effectiveDate('2026-12-31', '03:00')).toBe('2027-01-01');
		});
	});

	describe('zonedWallClockToUtcMs', () => {
		it('converts Europe/Berlin time to UTC correctly', () => {
			// 2026-07-18 is in summer (DST: UTC+2)
			// Wall clock 12:00 in Berlin = 10:00 UTC
			const utcMs = zonedWallClockToUtcMs('2026-07-18', '12:00', 'Europe/Berlin');
			const utcDate = new Date(utcMs);
			expect(utcDate.getUTCHours()).toBe(10);
			expect(utcDate.getUTCDate()).toBe(18);
		});

		it('handles winter DST offset (UTC+1)', () => {
			// 2026-01-15 is in winter (DST: UTC+1)
			// Wall clock 12:00 in Berlin = 11:00 UTC
			const utcMs = zonedWallClockToUtcMs('2026-01-15', '12:00', 'Europe/Berlin');
			const utcDate = new Date(utcMs);
			expect(utcDate.getUTCHours()).toBe(11);
		});

		it('handles midnight', () => {
			const utcMs = zonedWallClockToUtcMs('2026-07-18', '00:00', 'Europe/Berlin');
			const utcDate = new Date(utcMs);
			expect(utcDate.getUTCDate()).toBe(17); // Previous day in UTC
		});

		it('converts to epoch milliseconds', () => {
			const utcMs = zonedWallClockToUtcMs('2026-07-18', '12:00', 'Europe/Berlin');
			expect(typeof utcMs).toBe('number');
			expect(utcMs).toBeGreaterThan(0);
		});

		it('handles a zone west of UTC where the instant is on the next UTC day', () => {
			// 22:00 on 2026-07-18 in New York (EDT, UTC-4) = 02:00 UTC the *next* day.
			const utcMs = zonedWallClockToUtcMs('2026-07-18', '22:00', 'America/New_York');
			expect(new Date(utcMs).toISOString()).toBe('2026-07-19T02:00:00.000Z');
		});

		it('handles a half-hour zone', () => {
			// 12:00 in Kolkata (UTC+5:30) = 06:30 UTC.
			const utcMs = zonedWallClockToUtcMs('2026-07-18', '12:00', 'Asia/Kolkata');
			expect(new Date(utcMs).toISOString()).toBe('2026-07-18T06:30:00.000Z');
		});

		it('resolves a time after the spring-forward DST seam with the new offset', () => {
			// Europe/Berlin springs forward 2026-03-29 02:00→03:00. A 12:00 set that day is
			// already on summer time (UTC+2) → 10:00 UTC, not 11:00.
			const utcMs = zonedWallClockToUtcMs('2026-03-29', '12:00', 'Europe/Berlin');
			expect(new Date(utcMs).toISOString()).toBe('2026-03-29T10:00:00.000Z');
		});
	});

	describe('performanceStartUtcMs', () => {
		it('accounts for effective date rollover', () => {
			// 01:00 on calendar day 2026-07-18 -> effective date 2026-07-19 -> UTC conversion
			const ms1 = performanceStartUtcMs('2026-07-18', '01:00', 'Europe/Berlin');
			// 12:00 on calendar day 2026-07-18 -> stays 2026-07-18 -> UTC conversion
			const ms12 = performanceStartUtcMs('2026-07-18', '12:00', 'Europe/Berlin');
			// ms1 should be after ms12 (day 19 is after day 18)
			expect(ms1).toBeGreaterThan(ms12);
		});
	});

	describe('sendAtMs', () => {
		it('subtracts lead time from performance start', () => {
			const perfStart = 1000000;
			const lead = 10; // 10 minutes
			const sendTime = sendAtMs(perfStart, lead);
			expect(sendTime).toBe(1000000 - 10 * 60_000);
		});

		it('handles various lead times', () => {
			const perfStart = 5000000;
			expect(sendAtMs(perfStart, 5)).toBe(perfStart - 5 * 60_000);
			expect(sendAtMs(perfStart, 30)).toBe(perfStart - 30 * 60_000);
		});
	});

	describe('isDue', () => {
		const nowMs = 1000000;
		const windowMs = 3 * 60_000; // 3 minutes default

		it('returns true when sendAt is within the window', () => {
			expect(isDue(nowMs, nowMs)).toBe(true);
			expect(isDue(nowMs - 1000, nowMs)).toBe(true);
			expect(isDue(nowMs - windowMs + 1000, nowMs)).toBe(true);
		});

		it('returns false when sendAt is before the window', () => {
			expect(isDue(nowMs - windowMs - 1000, nowMs)).toBe(false);
		});

		it('returns false when sendAt is after now', () => {
			expect(isDue(nowMs + 1000, nowMs)).toBe(false);
		});

		it('respects custom window size', () => {
			const customWindow = 60_000; // 1 minute
			expect(isDue(nowMs - 30_000, nowMs, customWindow)).toBe(true);
			expect(isDue(nowMs - 120_000, nowMs, customWindow)).toBe(false);
		});

		it('uses window exclusivity correctly', () => {
			// (nowMs - windowMs, nowMs] means:
			// - open on the left (past the boundary = false)
			// - closed on the right (at nowMs = true)
			expect(isDue(nowMs - windowMs, nowMs)).toBe(false); // exactly at boundary
			expect(isDue(nowMs - windowMs + 1, nowMs)).toBe(true); // just after boundary
		});
	});

	describe('inCandidateWindow', () => {
		const nowMs = 1000000;

		it('accepts performances in the candidate window', () => {
			// Within [now - 3min, now + 33min]
			expect(inCandidateWindow(nowMs, nowMs)).toBe(true);
			expect(inCandidateWindow(nowMs - 1 * 60_000, nowMs)).toBe(true); // 1 min ago
			expect(inCandidateWindow(nowMs + 15 * 60_000, nowMs)).toBe(true); // 15 min ahead
		});

		it('rejects performances before the window', () => {
			expect(inCandidateWindow(nowMs - 5 * 60_000, nowMs)).toBe(false);
		});

		it('rejects performances after the window', () => {
			expect(inCandidateWindow(nowMs + 35 * 60_000, nowMs)).toBe(false);
		});

		it('accepts boundary cases', () => {
			const lookBackMs = 3 * 60_000;
			const lookAheadMs = 33 * 60_000;
			expect(inCandidateWindow(nowMs - lookBackMs, nowMs)).toBe(true);
			expect(inCandidateWindow(nowMs + lookAheadMs, nowMs)).toBe(true);
		});
	});

	describe('aggregateStates', () => {
		it('detects attending when state=1', () => {
			const agg = aggregateStates([1]);
			expect(agg.attending).toBe(true);
			expect(agg.maybe).toBe(false);
		});

		it('detects maybe when state=2', () => {
			const agg = aggregateStates([2]);
			expect(agg.attending).toBe(false);
			expect(agg.maybe).toBe(true);
		});

		it('detects both when both states present', () => {
			const agg = aggregateStates([1, 2]);
			expect(agg.attending).toBe(true);
			expect(agg.maybe).toBe(true);
		});

		it('handles empty array', () => {
			const agg = aggregateStates([]);
			expect(agg.attending).toBe(false);
			expect(agg.maybe).toBe(false);
		});

		it('handles unmarked state (0)', () => {
			const agg = aggregateStates([0, 0]);
			expect(agg.attending).toBe(false);
			expect(agg.maybe).toBe(false);
		});

		it('aggregates multiple rooms', () => {
			const agg = aggregateStates([0, 1, 0, 2, 1]);
			expect(agg.attending).toBe(true);
			expect(agg.maybe).toBe(true);
		});
	});

	describe('qualifies', () => {
		it('sends when attending, regardless of notifyMaybe', () => {
			const agg = { attending: true, maybe: false };
			expect(qualifies(agg, false)).toBe(true);
			expect(qualifies(agg, true)).toBe(true);
		});

		it('sends when maybe and notifyMaybe=true', () => {
			const agg = { attending: false, maybe: true };
			expect(qualifies(agg, true)).toBe(true);
		});

		it('does not send when maybe but notifyMaybe=false', () => {
			const agg = { attending: false, maybe: true };
			expect(qualifies(agg, false)).toBe(false);
		});

		it('does not send when user has no state', () => {
			const agg = { attending: false, maybe: false };
			expect(qualifies(agg, true)).toBe(false);
		});

		it('an override replaces the default rule for a marked performance', () => {
			// Attending would otherwise always send — override:false mutes it.
			expect(qualifies({ attending: true, maybe: false }, false, false)).toBe(false);
			// Maybe would otherwise be silent — override:true wakes it.
			expect(qualifies({ attending: false, maybe: true }, false, true)).toBe(true);
		});

		it('an override can never notify for a performance that was never marked', () => {
			const agg = { attending: false, maybe: false };
			expect(qualifies(agg, false, true)).toBe(false);
		});

		it('truth table: all combinations, with and without an override', () => {
			const cases = [
				// attending=T, maybe=F: always sends by default, regardless of notifyMaybe
				[{ attending: true, maybe: false }, true, undefined, true],
				[{ attending: true, maybe: false }, false, undefined, true],
				// attending=F, maybe=T: sends only if notifyMaybe=T
				[{ attending: false, maybe: true }, true, undefined, true],
				[{ attending: false, maybe: true }, false, undefined, false],
				// attending=T, maybe=T: attending alone is enough
				[{ attending: true, maybe: true }, true, undefined, true],
				[{ attending: true, maybe: true }, false, undefined, true],
				// attending=F, maybe=F: never sends, override or not
				[{ attending: false, maybe: false }, true, undefined, false],
				[{ attending: false, maybe: false }, true, true, false],
				[{ attending: false, maybe: false }, true, false, false],
				// a mark plus an explicit override: the override always wins
				[{ attending: true, maybe: false }, false, false, false],
				[{ attending: true, maybe: false }, false, true, true],
				[{ attending: false, maybe: true }, false, false, false],
				[{ attending: false, maybe: true }, false, true, true]
			];

			for (const [agg, notifyMaybe, override, expected] of cases) {
				expect(qualifies(agg as any, notifyMaybe as any, override as any)).toBe(expected as any);
			}
		});
	});
});

/**
 * The notifier's decision, on its own.
 *
 * Everything below used to be reachable only by running the whole Lambda against a scripted
 * sequence of DynamoDB responses, which is why marks spread across two rooms, or an override
 * on one of them, were awkward to state at all.
 */
describe('dueNotifications', () => {
	/** 22:00 Berlin on the frozen day = 20:00 UTC. */
	const SET = { id: 'p1', artist: 'Artist', stage: 'Main', startTime: '22:00', dayDate: '2026-07-18' };
	const FESTIVAL: FestivalCandidates = {
		festivalId: 'tmr26',
		timezone: 'Europe/Berlin',
		performances: [SET]
	};
	/** 15 minutes before the set, the default lead — so it is due exactly now. */
	const NOW = Date.parse('2026-07-18T19:45:00Z');

	function room(overrides: Partial<RoomPicks> = {}): RoomPicks {
		return {
			roomId: 'tmr26-aaa111',
			festivalId: 'tmr26',
			updatedAt: 5,
			selections: { p1: 1 },
			...overrides
		};
	}

	it('notifies a going mark at the default lead', () => {
		const due = dueNotifications({}, [FESTIVAL], [room()], NOW);

		expect(due).toHaveLength(1);
		expect(due[0]).toMatchObject({
			festivalId: 'tmr26',
			roomId: 'tmr26-aaa111',
			performance: { id: 'p1' }
		});
	});

	it.each([
		['an unmarked set', { selections: {} }],
		['a set marked 0', { selections: { p1: 0 } }],
		['a room belonging to another festival', { festivalId: 'ps26' }],
		['a non-numeric state', { selections: { p1: 'going' } }]
	])('stays quiet for %s', (_label, overrides) => {
		expect(dueNotifications({}, [FESTIVAL], [room(overrides)], NOW)).toEqual([]);
	});

	it('stays quiet when the user is in no rooms at all', () => {
		expect(dueNotifications({}, [FESTIVAL], [], NOW)).toEqual([]);
	});

	describe('the maybe rule', () => {
		const maybe = () => room({ selections: { p1: 2 } });

		it('holds a maybe back by default', () => {
			expect(dueNotifications({}, [FESTIVAL], [maybe()], NOW)).toEqual([]);
		});

		it('sends a maybe once the preference is on', () => {
			expect(dueNotifications({ notifyMaybe: true }, [FESTIVAL], [maybe()], NOW)).toHaveLength(1);
		});

		it('lets a per-set override wake a maybe on its own', () => {
			const prefs = { notifyMaybe: false, notifyOverrides: { p1: true } };
			expect(dueNotifications(prefs, [FESTIVAL], [maybe()], NOW)).toHaveLength(1);
		});

		it('lets a per-set override silence a going', () => {
			const prefs = { notifyOverrides: { p1: false } };
			expect(dueNotifications(prefs, [FESTIVAL], [room()], NOW)).toEqual([]);
		});

		it('never conjures one for a set the user did not mark', () => {
			const prefs = { notifyOverrides: { p1: true } };
			expect(dueNotifications(prefs, [FESTIVAL], [room({ selections: {} })], NOW)).toEqual([]);
		});
	});

	describe('a set marked in more than one room', () => {
		it('sends once, opening the most recently active room', () => {
			const picks = [
				room({ roomId: 'tmr26-older', updatedAt: 1 }),
				room({ roomId: 'tmr26-newer', updatedAt: 9 })
			];

			const due = dueNotifications({}, [FESTIVAL], picks, NOW);

			expect(due).toHaveLength(1);
			expect(due[0]?.roomId).toBe('tmr26-newer');
		});

		it('takes the strongest mark across rooms — going in one is enough', () => {
			// Maybe in the *first* room and going in the second, deliberately: with the going
			// mark first, reading only the first room would give the same answer, and this
			// would not distinguish aggregating from stopping at one. The tap-through still
			// opens the more recently active room, which here is the one holding the going.
			const picks = [
				room({ roomId: 'tmr26-older', updatedAt: 1, selections: { p1: 2 } }),
				room({ roomId: 'tmr26-newer', updatedAt: 9, selections: { p1: 1 } })
			];

			const due = dueNotifications({}, [FESTIVAL], picks, NOW);

			expect(due).toHaveLength(1);
			expect(due[0]?.roomId).toBe('tmr26-newer');
		});

		it('breaks a tie towards the room that comes last', () => {
			// Not a hypothetical: a room the user has never touched since the field was added
			// carries no updatedAt at all, and two of those both read as zero.
			const picks = [
				room({ roomId: 'tmr26-first', updatedAt: 0 }),
				room({ roomId: 'tmr26-second', updatedAt: 0 })
			];

			expect(dueNotifications({}, [FESTIVAL], picks, NOW)[0]?.roomId).toBe('tmr26-second');
		});

		it('ignores a room where the set is unmarked when choosing which to open', () => {
			const picks = [
				room({ roomId: 'tmr26-marked', updatedAt: 1 }),
				room({ roomId: 'tmr26-unmarked', updatedAt: 9, selections: {} })
			];

			expect(dueNotifications({}, [FESTIVAL], picks, NOW)[0]?.roomId).toBe('tmr26-marked');
		});
	});

	describe('timing', () => {
		it('holds back until the lead time is reached', () => {
			// A minute before the 15-minute lead: the set is a candidate, but not yet due.
			expect(dueNotifications({}, [FESTIVAL], [room()], NOW - 60_000)).toEqual([]);
		});

		it('honours a custom lead time', () => {
			const thirtyBefore = Date.parse('2026-07-18T19:30:00Z');

			expect(dueNotifications({ leadMinutes: 30 }, [FESTIVAL], [room()], thirtyBefore)).toHaveLength(1);
			expect(dueNotifications({}, [FESTIVAL], [room()], thirtyBefore)).toEqual([]);
		});

		it('reports when the set starts, for the dedup key', () => {
			const due = dueNotifications({}, [FESTIVAL], [room()], NOW);
			expect(due[0]?.perfStartMs).toBe(Date.parse('2026-07-18T20:00:00Z'));
		});
	});

	it('keeps festivals apart, matching each room to its own', () => {
		const other: FestivalCandidates = {
			festivalId: 'ps26',
			timezone: 'Europe/Madrid',
			performances: [{ ...SET, id: 'p2' }]
		};
		const picks = [
			room(),
			room({ roomId: 'ps26-bbb222', festivalId: 'ps26', selections: { p2: 1 } })
		];

		const due = dueNotifications({}, [FESTIVAL, other], picks, NOW);

		expect(due.map((item) => `${item.festivalId}:${item.performance.id}`)).toEqual([
			'tmr26:p1',
			'ps26:p2'
		]);
	});
});
