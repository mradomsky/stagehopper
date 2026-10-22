/**
 * @file Pure logic over Picks: cycling, filtering and colouring.
 */

import { PARTICIPANT_COLORS } from '$shared/colours.js';
import type { AttendeePick, SelectionMap, SelectionState } from './types.js';

export { PARTICIPANT_COLORS };

export const DEFAULT_COLOR: string = PARTICIPANT_COLORS[0];

/** Longest display name we store; also enforced server-side. */
const MAX_NAME_LENGTH = 50;

/** Trim and cap a display name to what the backend will accept. */
export function truncateName(value: string): string {
	return value.trim().slice(0, MAX_NAME_LENGTH);
}

/** Cycle through selection states: 0 (unmarked) → 1 (going) → 2 (maybe) → 0. */
export function cycleState(state: SelectionState): SelectionState {
	return ((state + 1) % 3) as SelectionState;
}

/** Read one performance's state out of a selection map. */
export function stateOf(selections: SelectionMap, performanceId: string): SelectionState {
	return selections[performanceId] ?? 0;
}

/** Convert a participant name into a single badge letter. */
export function getParticipantInitial(name: string): string {
	const trimmed = name.trim();
	return (trimmed[0] ?? '?').toUpperCase();
}

/** Parse a `#rrggbb` colour into its channels. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
	return {
		r: parseInt(hex.slice(1, 3), 16),
		g: parseInt(hex.slice(3, 5), 16),
		b: parseInt(hex.slice(5, 7), 16)
	};
}

// theme:palette:start
/** Convert a `#rrggbb` colour to an `rgba()` string. */
export function colorWithOpacity(hex: string, opacity: number): string {
	const { r, g, b } = hexToRgb(hex);
	return `rgba(${r},${g},${b},${opacity})`;
}
// theme:palette:end

export interface MarkDotVisuals {
	background: string;
	border: string;
}

/** Background/border for a participant's mark dot: solid for going, faint for maybe. */
export function markDotStyle(mark: Pick<AttendeePick, 'color' | 'state'>): MarkDotVisuals {
	return {
		background: colorWithOpacity(mark.color, mark.state === 2 ? 0.35 : 0.92),
		border: colorWithOpacity(mark.color, mark.state === 2 ? 0.7 : 1)
	};
}

export interface SelectionVisuals {
	background: string;
	border: string;
}

/**
 * How a performance block is tinted: by its stage, or neutral when the stage has no colour.
 *
 * Takes neither the viewer's colour nor their mark, because neither changes the answer. The
 * star is the sole going/maybe signal, and the background belongs to the stage — a block
 * that also recoloured itself per mark made the two signals compete. Both were still
 * parameters long after they stopped being read, which left the tests asserting the
 * independence that dropping them now states outright.
 */
export function getSelectionVisuals(stageColor?: string): SelectionVisuals {
	const background = stageColor ? colorWithOpacity(stageColor, 0.5) : 'var(--sh-block-bg)';
	return { background, border: 'var(--sh-block-border)' };
}

/**
 * Inline style that tints a stage header: the stage colour at half opacity layered over the
 * header's themed base colour. The same pixels as an opaque 50% blend, without computing a
 * colour in script.
 */
export function stageHeaderTint(stageColor?: string): string | undefined {
	return stageColor
		? `background-image: linear-gradient(${colorWithOpacity(stageColor, 0.5)} 0 0);`
		: undefined;
}
