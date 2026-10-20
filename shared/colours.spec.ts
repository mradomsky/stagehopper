import { describe, expect, it } from 'vitest';
import { PARTICIPANT_COLORS, isPaletteColour } from './colours.js';

describe('isPaletteColour', () => {
	it('accepts every palette colour', () => {
		for (const colour of PARTICIPANT_COLORS) expect(isPaletteColour(colour)).toBe(true);
	});

	it('compares case-insensitively', () => {
		expect(isPaletteColour('#E74C3C')).toBe(true);
	});

	it('rejects colours outside the palette', () => {
		expect(isPaletteColour('#000000')).toBe(false);
		expect(isPaletteColour('e74c3c')).toBe(false);
	});

	it('rejects non-strings', () => {
		expect(isPaletteColour(undefined)).toBe(false);
		expect(isPaletteColour(null)).toBe(false);
		expect(isPaletteColour(0xe74c3c)).toBe(false);
	});
});
