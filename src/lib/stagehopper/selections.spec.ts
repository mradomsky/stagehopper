import { describe, expect, it } from 'vitest';
import {
	colorWithOpacity,
	cycleState,
	getParticipantInitial,
	getSelectionVisuals,
	stageHeaderTint,
	stateOf,
	truncateName
} from './selections.js';

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

// The viewer's mark and colour used to be arguments here, and two of these tests existed to
// assert they changed nothing. They are no longer arguments, so the signature states that and
// the tests below only have the stage colour left to describe.
describe('getSelectionVisuals', () => {
	it('uses neutral styling when the stage has no colour', () => {
		expect(getSelectionVisuals()).toEqual({
			background: 'var(--sh-block-bg)',
			border: 'var(--sh-block-border)'
		});
	});

	it('backgrounds with the dimmed stage colour when one is set, keeping the border neutral', () => {
		const stageColor = '#3498db';
		expect(getSelectionVisuals(stageColor)).toEqual({
			background: colorWithOpacity(stageColor, 0.5),
			border: 'var(--sh-block-border)'
		});
	});
});

describe('stageHeaderTint', () => {
	it('layers the stage colour at half opacity as a background image, over the themed base', () => {
		expect(stageHeaderTint('#3498db')).toBe(
			'background-image: linear-gradient(rgba(52,152,219,0.5) 0 0);'
		);
	});

	it('adds nothing when the stage has no colour', () => {
		expect(stageHeaderTint()).toBeUndefined();
	});
});
