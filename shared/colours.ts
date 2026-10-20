/**
 * @file The participant colour palette, shared by the SPA and the Lambda so both validate the same list.
 */

// theme:palette:start
/** Palette participants pick from; each colour is claimed by at most one person per room. */
export const PARTICIPANT_COLORS = [
	'#e74c3c',
	'#3498db',
	'#2ecc71',
	'#f39c12',
	'#9b59b6',
	'#1abc9c',
	'#e5d62e',
	'#cee26f',
	'#99e52e',
	'#95e26f',
	'#3de52e',
	'#6fe282',
	'#2ed3e5',
	'#6f91e2',
	'#3d2ee5',
	'#a36fe2',
	'#dc2ee5',
	'#e26fc5',
	'#e52e81',
	'#e26f80'
] as const;
// theme:palette:end

export type PaletteColour = (typeof PARTICIPANT_COLORS)[number];

/** True when `value` is a palette colour; the comparison ignores case. */
export function isPaletteColour(value: unknown): value is PaletteColour {
	return (
		typeof value === 'string' && (PARTICIPANT_COLORS as readonly string[]).includes(value.toLowerCase())
	);
}
