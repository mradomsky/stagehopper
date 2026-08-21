/**
 * @file Pure logic over participants' picks: cycling, merging, filtering and colouring.
 */

import type {
	ParticipantMark,
	RoomSelection,
	SelectionMap,
	SelectionState,
	StageWithPerformances
} from './types.js';

/** Palette participants pick from; each colour is claimed by at most one person per room. */
export const PARTICIPANT_COLORS = [
	'#e74c3c',
	'#3498db',
	'#2ecc71',
	'#f39c12',
	'#9b59b6',
	'#1abc9c',
	'#fd79a8',
	'#fdcb6e',
	'#e84393',
	'#00b894',
	'#0984e3',
	'#6c5ce7',
	'#d63031',
	'#00cec9',
	'#a29bfe',
	'#fab1a0',
	'#55efc4',
	'#ff7675',
	'#74b9ff',
	'#ffeaa7'
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

/** Filter stages down to those with at least one performance marked by someone. */
export function filterPicks(
	stagesForDay: StageWithPerformances[],
	allSelections: Pick<RoomSelection, 'selections'>[]
): StageWithPerformances[] {
	return stagesForDay
		.map((stage) => ({
			...stage,
			performances: stage.performances.filter((performance) =>
				allSelections.some((selection) => stateOf(selection.selections, performance.id) > 0)
			)
		}))
		.filter((stage) => stage.performances.length > 0);
}

export interface MergeResult {
	remoteViewerFound: boolean;
	viewerSelections: SelectionMap;
	viewerColor: string;
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

	return {
		remoteViewerFound: Boolean(remoteViewer),
		viewerSelections,
		viewerColor,
		allSelections: [
			...remoteSelections.filter((selection) => selection.userId !== viewer.userId),
			viewerEntry
		]
	};
}

/** Convert a participant name into a single badge letter. */
export function getParticipantInitial(name: string): string {
	const trimmed = name.trim();
	return (trimmed[0] ?? '?').toUpperCase();
}

/** Convert a `#rrggbb` colour to an `rgba()` string. */
export function colorWithOpacity(hex: string, opacity: number): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
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

/** Background/border for a performance block, given the viewer's colour and mark. */
export function getSelectionVisuals(color: string, state: SelectionState): SelectionVisuals {
	if (state === 0) {
		return { background: '#242424', border: '#3a3a3a' };
	}
	if (state === 1) {
		return {
			background: colorWithOpacity(color, 0.42),
			border: colorWithOpacity(color, 0.88)
		};
	}
	return {
		background: colorWithOpacity(color, 0.22),
		border: colorWithOpacity(color, 0.56)
	};
}

/**
 * Restrict room selections to the current user plus the selected other users.
 * A null filter means "show everyone".
 */
export function filterSelectionsByParticipantIds<T extends { userId: string }>(
	allSelections: T[],
	currentUserId: string,
	selectedOtherUserIds: string[] | null
): T[] {
	if (!selectedOtherUserIds) {
		return allSelections;
	}
	const selectedIds = new Set(selectedOtherUserIds);
	return allSelections.filter(
		(selection) => selection.userId === currentUserId || selectedIds.has(selection.userId)
	);
}

/**
 * Normalize the locally stored selected-user filter against who is actually in the room.
 * Null means "show everyone". An empty array means "only me".
 */
export function normalizeSelectedOtherUserIds(
	selectedOtherUserIds: string[] | null,
	availableOtherUserIds: string[]
): string[] | null {
	if (!selectedOtherUserIds) {
		return null;
	}
	const availableIdSet = new Set(availableOtherUserIds);
	const normalized = [...new Set(selectedOtherUserIds)].filter((userId) =>
		availableIdSet.has(userId)
	);
	return normalized.length === availableOtherUserIds.length ? null : normalized;
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
