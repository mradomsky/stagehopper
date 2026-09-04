/**
 * @file Pure logic over participants' picks: cycling, merging, filtering and colouring.
 */

import type { ParticipantMark, RoomSelection, SelectionMap, SelectionState } from './types.js';

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

export interface MergeResult {
	remoteViewerFound: boolean;
	viewerSelections: SelectionMap;
	viewerColor: string;
	viewerName: string;
	/** Everyone but the viewer. What the caller stores; the viewer folds back in on read. */
	otherSelections: RoomSelection[];
	allSelections: RoomSelection[];
}

/**
 * Merge room selections from the backend with the current viewer's local state.
 *
 * On first load after a reload, the viewer's local selections are empty, so we
 * hydrate them from the backend. After local interaction starts, the local
 * snapshot stays authoritative until the pending PUT is flushed.
 */
export function mergeSelectionsForViewer(
	remoteSelections: RoomSelection[],
	viewer: RoomSelection,
	options: { preferRemoteColor?: boolean } = {}
): MergeResult {
	const remoteViewer = remoteSelections.find((selection) => selection.userId === viewer.userId);
	const hasLocalSnapshot = Object.keys(viewer.selections).length > 0;
	const viewerSelections =
		hasLocalSnapshot || !remoteViewer ? viewer.selections : remoteViewer.selections;
	const viewerColor =
		options.preferRemoteColor && remoteViewer?.color ? remoteViewer.color : viewer.color;
	const viewerName = viewer.name || remoteViewer?.name || '';

	const viewerEntry: RoomSelection = {
		...(remoteViewer ?? { userId: viewer.userId }),
		userId: viewer.userId,
		name: viewerName,
		color: viewerColor,
		selections: viewerSelections
	};

	const otherSelections = remoteSelections.filter(
		(selection) => selection.userId !== viewer.userId
	);

	return {
		remoteViewerFound: Boolean(remoteViewer),
		viewerSelections,
		viewerColor,
		viewerName,
		otherSelections,
		allSelections: [...otherSelections, viewerEntry]
	};
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

/** Convert a `#rrggbb` colour to an `rgba()` string. */
export function colorWithOpacity(hex: string, opacity: number): string {
	const { r, g, b } = hexToRgb(hex);
	return `rgba(${r},${g},${b},${opacity})`;
}

export interface MarkDotVisuals {
	background: string;
	border: string;
}

/** Background/border for a participant's mark dot: solid for going, faint for maybe. */
export function markDotStyle(mark: Pick<ParticipantMark, 'color' | 'state'>): MarkDotVisuals {
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
 * Background/border for a performance block. The background always reflects the stage's
 * colour (dimmed) when the festival has one set. The border stays neutral regardless of
 * the viewer's mark — the going/maybe signal lives solely in the star now.
 */
export function getSelectionVisuals(
	color: string,
	state: SelectionState,
	stageColor?: string
): SelectionVisuals {
	const background = stageColor ? colorWithOpacity(stageColor, 0.5) : '#242424';
	return { background, border: '#3a3a3a' };
}

/** Blend a hex colour toward a base hex colour by `ratio` (0 = base, 1 = full colour). */
export function mixHex(hex: string, base: string, ratio: number): string {
	const c = hexToRgb(hex);
	const b = hexToRgb(base);
	const mix = (a: number, bv: number) => Math.round(a * ratio + bv * (1 - ratio));
	return `rgb(${mix(c.r, b.r)},${mix(c.g, b.g)},${mix(c.b, b.b)})`;
}

/** Everyone who marked the given performance, in render order. */
export function getParticipantMarks(
	selections: RoomSelection[],
	performanceId: string
): ParticipantMark[] {
	return selections
		.map((selection) => ({
			userId: selection.userId,
			name: selection.name,
			color: selection.color,
			state: stateOf(selection.selections, performanceId)
		}))
		.filter((mark) => mark.state > 0);
}

/** The first palette colour not already claimed by another participant in the room. */
export function firstAvailableColor(takenColors: ReadonlySet<string>): string {
	return PARTICIPANT_COLORS.find((color) => !takenColors.has(color)) ?? DEFAULT_COLOR;
}

/** Colours already claimed by participants other than the viewer. */
export function takenColorsExcluding(
	allSelections: RoomSelection[],
	viewerUserId: string
): Set<string> {
	return new Set(
		allSelections.filter((s) => s.userId !== viewerUserId).map((selection) => selection.color)
	);
}
