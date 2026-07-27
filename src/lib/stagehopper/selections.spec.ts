import { describe, expect, it } from 'vitest';
import {
	colorWithOpacity,
	cycleState,
	filterPicks,
	filterSelectionsByParticipantIds,
	firstAvailableColor,
	getParticipantInitial,
	getParticipantMarks,
	getSelectionVisuals,
	mergeSelectionsForViewer,
	normalizeSelectedOtherUserIds,
	PARTICIPANT_COLORS,
	stateOf,
	takenColorsExcluding,
	truncateName
} from './selections.js';
import type { Performance, RoomSelection, StageWithPerformances } from './types.js';

function perf(id: string): Performance {
	return { id, artist: id, stage: 'S', startTime: '14:00', endTime: '15:00' };
}

function selection(userId: string, overrides: Partial<RoomSelection> = {}): RoomSelection {
	return {
		userId,
		name: userId,
		color: '#e74c3c',
		selections: {},
		...overrides
	};
}

describe('cycleState', () => {
	it('cycles unmarked → going → maybe → unmarked', () => {
		expect(cycleState(0)).toBe(1);
		expect(cycleState(1)).toBe(2);
		expect(cycleState(2)).toBe(0);
	});
});

describe('stateOf', () => {
	it('defaults missing performances to unmarked', () => {
		expect(stateOf({ a: 2 }, 'b')).toBe(0);
		expect(stateOf({ a: 2 }, 'a')).toBe(2);
	});
});

describe('truncateName', () => {
	it('trims and caps at 50 characters', () => {
		expect(truncateName('  Alex  ')).toBe('Alex');
		expect(truncateName('x'.repeat(80))).toHaveLength(50);
	});
});

describe('filterPicks', () => {
	const stages: StageWithPerformances[] = [
		{ name: 'STAGE A', performances: [perf('a1'), perf('a2')] },
		{ name: 'STAGE B', performances: [perf('b1')] }
	];

	it('returns nothing when nobody has picked', () => {
		expect(filterPicks(stages, [])).toEqual([]);
	});

	it('keeps only stages with a marked performance', () => {
		const result = filterPicks(stages, [{ selections: { a1: 1, b1: 0 } }]);
		expect(result).toHaveLength(1);
		expect(result[0]?.name).toBe('STAGE A');
		expect(result[0]?.performances.map((p) => p.id)).toEqual(['a1']);
	});

	it('includes maybe picks', () => {
		const result = filterPicks(stages, [{ selections: { b1: 2 } }]);
		expect(result[0]?.name).toBe('STAGE B');
	});

	it('unions picks across participants', () => {
		const result = filterPicks(stages, [{ selections: { a2: 0 } }, { selections: { a2: 1 } }]);
		expect(result[0]?.performances[0]?.id).toBe('a2');
	});
});

describe('mergeSelectionsForViewer', () => {
	it('hydrates the viewer from the backend when local selections are empty', () => {
		const result = mergeSelectionsForViewer(
			[
				selection('friend', { name: 'Sam', color: '#3498db', selections: { a1: 1 } }),
				selection('me', { name: 'Alex', selections: { b1: 2 } })
			],
			selection('me', { name: 'Alex', selections: {} })
		);

		expect(result.remoteViewerFound).toBe(true);
		expect(result.viewerSelections).toEqual({ b1: 2 });
		expect(result.allSelections).toHaveLength(2);
		expect(result.allSelections.at(-1)?.userId).toBe('me');
	});

	it('preserves local viewer edits over the last backend snapshot', () => {
		const result = mergeSelectionsForViewer(
			[selection('me', { name: 'Alex', selections: { b1: 1 } })],
			selection('me', { name: 'Alex', selections: { b1: 2, c1: 1 } })
		);

		expect(result.viewerSelections).toEqual({ b1: 2, c1: 1 });
	});

	it('adds the viewer when the backend has never seen them', () => {
		const result = mergeSelectionsForViewer(
			[selection('friend')],
			selection('me', { name: 'Alex' })
		);

		expect(result.remoteViewerFound).toBe(false);
		expect(result.allSelections.map((s) => s.userId)).toEqual(['friend', 'me']);
	});

	it('can hydrate the viewer colour from the backend', () => {
		const result = mergeSelectionsForViewer(
			[selection('me', { color: '#3498db' })],
			selection('me', { color: '#e74c3c' }),
			{ preferRemoteColor: true }
		);

		expect(result.viewerColor).toBe('#3498db');
	});

	it('keeps the local colour when the caller has not asked for the remote one', () => {
		const result = mergeSelectionsForViewer(
			[selection('me', { color: '#3498db' })],
			selection('me', { color: '#e74c3c' })
		);

		expect(result.viewerColor).toBe('#e74c3c');
	});
});

describe('getParticipantInitial', () => {
	it('uses the first trimmed letter, uppercased', () => {
		expect(getParticipantInitial(' alex')).toBe('A');
	});

	it('falls back to a placeholder for an empty name', () => {
		expect(getParticipantInitial('   ')).toBe('?');
	});
});

describe('colorWithOpacity', () => {
	it('converts hex to rgba', () => {
		expect(colorWithOpacity('#e74c3c', 0.5)).toBe('rgba(231,76,60,0.5)');
	});
});

describe('getSelectionVisuals', () => {
	it('uses neutral styling when unmarked', () => {
		expect(getSelectionVisuals('#e74c3c', 0)).toEqual({
			background: '#242424',
			border: '#3a3a3a'
		});
	});

	it('tints going more strongly than maybe', () => {
		expect(getSelectionVisuals('#e74c3c', 1).background).toBe(colorWithOpacity('#e74c3c', 0.42));
		expect(getSelectionVisuals('#e74c3c', 2).background).toBe(colorWithOpacity('#e74c3c', 0.22));
	});
});

describe('filterSelectionsByParticipantIds', () => {
	const selections = [selection('me'), selection('a'), selection('b')];

	it('returns everyone when there is no explicit filter', () => {
		expect(filterSelectionsByParticipantIds(selections, 'me', null)).toEqual(selections);
	});

	it('always keeps the current user and only the selected others', () => {
		expect(
			filterSelectionsByParticipantIds(selections, 'me', ['b']).map((s) => s.userId)
		).toEqual(['me', 'b']);
	});

	it('keeps only the current user for an empty filter', () => {
		expect(filterSelectionsByParticipantIds(selections, 'me', []).map((s) => s.userId)).toEqual([
			'me'
		]);
	});
});

describe('normalizeSelectedOtherUserIds', () => {
	it('keeps null as the all-users state', () => {
		expect(normalizeSelectedOtherUserIds(null, ['a', 'b'])).toBeNull();
	});

	it('drops users who left the room', () => {
		expect(normalizeSelectedOtherUserIds(['a', 'missing'], ['a', 'b'])).toEqual(['a']);
	});

	it('collapses a full explicit selection back to the all-users state', () => {
		expect(normalizeSelectedOtherUserIds(['b', 'a'], ['a', 'b'])).toBeNull();
	});

	it('preserves an empty selection as only-me mode', () => {
		expect(normalizeSelectedOtherUserIds([], ['a', 'b'])).toEqual([]);
	});

	it('de-duplicates repeated ids', () => {
		expect(normalizeSelectedOtherUserIds(['a', 'a'], ['a', 'b'])).toEqual(['a']);
	});
});

describe('getParticipantMarks', () => {
	it('returns only participants who marked the performance', () => {
		const marks = getParticipantMarks(
			[
				selection('a', { selections: { p1: 1 } }),
				selection('b', { selections: { p1: 0 } }),
				selection('c', { selections: { p1: 2 } })
			],
			'p1'
		);

		expect(marks.map((mark) => [mark.userId, mark.state])).toEqual([
			['a', 1],
			['c', 2]
		]);
	});
});

describe('colour assignment', () => {
	it('reports colours claimed by everyone but the viewer', () => {
		const taken = takenColorsExcluding(
			[selection('me', { color: '#e74c3c' }), selection('a', { color: '#3498db' })],
			'me'
		);
		expect([...taken]).toEqual(['#3498db']);
	});

	it('picks the first unclaimed palette colour', () => {
		expect(firstAvailableColor(new Set([PARTICIPANT_COLORS[0]]))).toBe(PARTICIPANT_COLORS[1]);
	});

	it('falls back to the first colour when the palette is exhausted', () => {
		expect(firstAvailableColor(new Set(PARTICIPANT_COLORS))).toBe(PARTICIPANT_COLORS[0]);
	});
});
