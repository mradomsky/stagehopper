import { describe, it, expect } from 'vitest';
import {
	colorWithOpacity,
	cycleState,
	filterPicks,
	filterSelectionsByParticipantIds,
	getParticipantInitial,
	getSelectionVisuals,
	mergeSelectionsForViewer,
	normalizeSelectedOtherUserIds,
	shouldTriggerDaySwipe,
	timeToGridMin
} from './utils.js';

describe('cycleState', () => {
	it('cycles 0 → 1', () => {
		expect(cycleState(0)).toBe(1);
	});

	it('cycles 1 → 2', () => {
		expect(cycleState(1)).toBe(2);
	});

	it('cycles 2 → 0', () => {
		expect(cycleState(2)).toBe(0);
	});
});

describe('timeToGridMin', () => {
	it('maps 14:00 to 840', () => {
		expect(timeToGridMin('14:00')).toBe(840);
	});

	it('maps 00:00 to 1440 (post-midnight)', () => {
		expect(timeToGridMin('00:00')).toBe(1440);
	});

	it('maps 02:30 to 1590 (post-midnight)', () => {
		expect(timeToGridMin('02:30')).toBe(1590);
	});

	it('maps 23:59 to 1439', () => {
		expect(timeToGridMin('23:59')).toBe(1439);
	});
});

describe('filterPicks', () => {
	const stages = [
		{
			name: 'STAGE A',
			performances: [{ id: 'a1' }, { id: 'a2' }]
		},
		{
			name: 'STAGE B',
			performances: [{ id: 'b1' }]
		}
	];

	it('returns empty when no selections', () => {
		expect(filterPicks(stages, [])).toEqual([]);
	});

	it('returns only stages with a marked performance', () => {
		const allSelections = [{ selections: { a1: 1, b1: 0 } }];
		const result = filterPicks(stages, allSelections);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe('STAGE A');
		expect(result[0].performances).toHaveLength(1);
		expect(result[0].performances[0].id).toBe('a1');
	});

	it('includes state=2 (maybe) picks', () => {
		const allSelections = [{ selections: { b1: 2 } }];
		const result = filterPicks(stages, allSelections);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe('STAGE B');
	});

	it('considers picks across multiple users', () => {
		const allSelections = [{ selections: { a2: 0 } }, { selections: { a2: 1 } }];
		const result = filterPicks(stages, allSelections);
		expect(result[0].performances[0].id).toBe('a2');
	});
});

describe('mergeSelectionsForViewer', () => {
	it('hydrates the viewer from the backend when local selections are empty', () => {
		const result = mergeSelectionsForViewer(
			[
				{ userId: 'friend', name: 'Sam', color: '#3498db', selections: { a1: 1 } },
				{ userId: 'me', name: 'Alex', color: '#e74c3c', selections: { b1: 2 } }
			],
			{ userId: 'me', name: 'Alex', color: '#e74c3c', selections: {} }
		);

		expect(result.remoteViewerFound).toBe(true);
		expect(result.viewerSelections).toEqual({ b1: 2 });
		expect(result.viewerColor).toBe('#e74c3c');
		expect(result.allSelections).toEqual([
			{ userId: 'friend', name: 'Sam', color: '#3498db', selections: { a1: 1 } },
			{ userId: 'me', name: 'Alex', color: '#e74c3c', selections: { b1: 2 } }
		]);
	});

	it('preserves local viewer selections over the last backend snapshot', () => {
		const result = mergeSelectionsForViewer(
			[{ userId: 'me', name: 'Alex', color: '#e74c3c', selections: { b1: 1 } }],
			{ userId: 'me', name: 'Alex', color: '#e74c3c', selections: { b1: 2, c1: 1 } }
		);

		expect(result.remoteViewerFound).toBe(true);
		expect(result.viewerSelections).toEqual({ b1: 2, c1: 1 });
		expect(result.viewerColor).toBe('#e74c3c');
		expect(result.allSelections).toEqual([
			{ userId: 'me', name: 'Alex', color: '#e74c3c', selections: { b1: 2, c1: 1 } }
		]);
	});

	it('can hydrate the viewer color from the backend when no local color exists', () => {
		const result = mergeSelectionsForViewer(
			[{ userId: 'me', name: 'Alex', color: '#3498db', selections: {} }],
			{ userId: 'me', name: 'Alex', color: '#e74c3c', selections: {} },
			{ preferRemoteColor: true }
		);

		expect(result.viewerColor).toBe('#3498db');
		expect(result.allSelections).toEqual([
			{ userId: 'me', name: 'Alex', color: '#3498db', selections: {} }
		]);
	});
});

describe('getParticipantInitial', () => {
	it('uses the first trimmed letter and uppercases it', () => {
		expect(getParticipantInitial(' alex')).toBe('A');
	});

	it('falls back to a placeholder when the name is empty', () => {
		expect(getParticipantInitial('   ')).toBe('?');
	});
});

describe('getSelectionVisuals', () => {
	it('returns the default unselected styling', () => {
		expect(getSelectionVisuals('#e74c3c', 0)).toEqual({
			background: '#242424',
			border: '#3a3a3a'
		});
	});

	it('uses a muted tint for yes selections', () => {
		expect(getSelectionVisuals('#e74c3c', 1)).toEqual({
			background: colorWithOpacity('#e74c3c', 0.42),
			border: colorWithOpacity('#e74c3c', 0.88)
		});
	});

	it('uses a lighter tint for maybe selections', () => {
		expect(getSelectionVisuals('#e74c3c', 2)).toEqual({
			background: colorWithOpacity('#e74c3c', 0.22),
			border: colorWithOpacity('#e74c3c', 0.56)
		});
	});
});

describe('shouldTriggerDaySwipe', () => {
	it('allows a next-day swipe only from the right edge', () => {
		expect(
			shouldTriggerDaySwipe({
				dx: -90,
				dy: 10,
				scrollLeftAtStart: 284,
				maxScrollLeft: 300
			})
		).toBe(true);
		expect(
			shouldTriggerDaySwipe({
				dx: -90,
				dy: 10,
				scrollLeftAtStart: 180,
				maxScrollLeft: 300
			})
		).toBe(false);
	});

	it('allows a previous-day swipe only from the left edge', () => {
		expect(
			shouldTriggerDaySwipe({
				dx: 90,
				dy: 10,
				scrollLeftAtStart: 10,
				maxScrollLeft: 300
			})
		).toBe(true);
		expect(
			shouldTriggerDaySwipe({
				dx: 90,
				dy: 10,
				scrollLeftAtStart: 40,
				maxScrollLeft: 300
			})
		).toBe(false);
	});

	it('ignores gestures that do not qualify as horizontal swipes', () => {
		expect(
			shouldTriggerDaySwipe({
				dx: 40,
				dy: 10,
				scrollLeftAtStart: 0,
				maxScrollLeft: 300
			})
		).toBe(false);
		expect(
			shouldTriggerDaySwipe({
				dx: 90,
				dy: 120,
				scrollLeftAtStart: 0,
				maxScrollLeft: 300
			})
		).toBe(false);
	});
});

describe('filterSelectionsByParticipantIds', () => {
	it('returns everyone when there is no explicit filter', () => {
		const selections = [{ userId: 'me' }, { userId: 'a' }, { userId: 'b' }];
		expect(filterSelectionsByParticipantIds(selections, 'me', null)).toEqual(selections);
	});

	it('always keeps the current user and only selected others', () => {
		const selections = [{ userId: 'me' }, { userId: 'a' }, { userId: 'b' }];
		expect(filterSelectionsByParticipantIds(selections, 'me', ['b'])).toEqual([
			{ userId: 'me' },
			{ userId: 'b' }
		]);
	});
});

describe('normalizeSelectedOtherUserIds', () => {
	it('keeps null as the all-users state', () => {
		expect(normalizeSelectedOtherUserIds(null, ['a', 'b'])).toBeNull();
	});

	it('drops users that are no longer available', () => {
		expect(normalizeSelectedOtherUserIds(['a', 'missing'], ['a', 'b'])).toEqual(['a']);
	});

	it('collapses a full explicit selection back to the all-users state', () => {
		expect(normalizeSelectedOtherUserIds(['b', 'a'], ['a', 'b'])).toBeNull();
	});

	it('preserves an empty selection as only-me mode', () => {
		expect(normalizeSelectedOtherUserIds([], ['a', 'b'])).toEqual([]);
	});
});
