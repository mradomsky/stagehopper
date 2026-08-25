import { describe, expect, it } from 'vitest';
import {
	colorWithOpacity,
	cycleState,
	firstAvailableColor,
	getParticipantInitial,
	getParticipantMarks,
	getSelectionVisuals,
	mergeSelectionsForViewer,
	mixHex,
	PARTICIPANT_COLORS,
	stateOf,
	takenColorsExcluding,
	truncateName
} from './selections.js';
import type { RoomSelection } from './types.js';

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
	it('uses neutral styling when unmarked and no stage colour is set', () => {
		expect(getSelectionVisuals('#e74c3c', 0)).toEqual({
			background: '#242424',
			border: '#3a3a3a'
		});
	});

	it('keeps the border neutral regardless of state — the star is the sole going/maybe signal', () => {
		expect(getSelectionVisuals('#e74c3c', 1)).toEqual({
			background: '#242424',
			border: '#3a3a3a'
		});
		expect(getSelectionVisuals('#e74c3c', 2)).toEqual({
			background: '#242424',
			border: '#3a3a3a'
		});
	});

	it('backgrounds every state with the dimmed stage colour when one is set', () => {
		const stageColor = '#3498db';
		for (const state of [0, 1, 2] as const) {
			expect(getSelectionVisuals('#e74c3c', state, stageColor).background).toBe(
				colorWithOpacity(stageColor, 0.5)
			);
		}
	});
});

describe('mixHex', () => {
	it('blends toward the target colour by the given ratio', () => {
		expect(mixHex('#ffffff', '#000000', 0.5)).toBe('rgb(128,128,128)');
		expect(mixHex('#e74c3c', '#141414', 0)).toBe('rgb(20,20,20)');
		expect(mixHex('#e74c3c', '#141414', 1)).toBe('rgb(231,76,60)');
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
