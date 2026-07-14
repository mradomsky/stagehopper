/**
 * @file StageHopper shared utility functions.
 * Extracted here for testability; also used by the room page component.
 */

export const GRID_START_MIN = 9 * 60; // 09:00 = 540

/**
 * Convert an HH:MM time string to minutes on the festival grid.
 * Times before 14:00 are treated as post-midnight (next calendar day).
 * @param {string} hhmm
 * @returns {number}
 */
export function timeToGridMin(hhmm) {
	const [h, m] = hhmm.split(':').map(Number);
	const total = h * 60 + m;
	return total < GRID_START_MIN ? total + 1440 : total;
}

/**
 * Cycle through selection states: 0 → 1 → 2 → 0.
 * 0 = unmarked, 1 = want to go, 2 = maybe.
 * @param {0|1|2} state
 * @returns {0|1|2}
 */
export function cycleState(state) {
	return /** @type {0|1|2} */ ((state + 1) % 3);
}

/**
 * Filter stages to only those with at least one marked performance.
 * @param {Array<{ name: string; performances: Array<{ id: string }> }>} stagesForDay
 * @param {Array<{ selections: Record<string, number> }>} allSelections
 * @returns {Array<{ name: string; performances: Array<{ id: string }> }>}
 */
export function filterPicks(stagesForDay, allSelections) {
	return stagesForDay
		.map((s) => ({
			...s,
			performances: s.performances.filter((p) =>
				allSelections.some((sel) => (sel.selections[p.id] ?? 0) > 0)
			)
		}))
		.filter((s) => s.performances.length > 0);
}

/**
 * Merge room selections from the backend with the current viewer's local state.
 * On first load after a reload, the viewer's local selections are empty, so we
 * hydrate them from the backend. After local interaction starts, the local
 * snapshot stays authoritative until the pending PUT is flushed.
 *
 * @param {Array<{ userId: string; name: string; color: string; selections: Record<string, 0|1|2> }>} remoteSelections
 * @param {{ userId: string; name: string; color: string; selections: Record<string, 0|1|2> }} viewer
 * @param {{ preferRemoteColor?: boolean }} [options]
 * @returns {{
 * 	remoteViewerFound: boolean,
 * 	viewerSelections: Record<string, 0|1|2>,
 * 	viewerColor: string,
 * 	allSelections: Array<{ userId: string; name: string; color: string; selections: Record<string, 0|1|2> }>
 * }}
 */
export function mergeSelectionsForViewer(remoteSelections, viewer, options = {}) {
	const remoteViewer = remoteSelections.find((sel) => sel.userId === viewer.userId);
	const hasLocalSnapshot = Object.keys(viewer.selections).length > 0;
	const viewerSelections =
		hasLocalSnapshot || !remoteViewer ? viewer.selections : remoteViewer.selections;
	const viewerColor =
		options.preferRemoteColor && remoteViewer?.color ? remoteViewer.color : viewer.color;
	const viewerName = viewer.name || remoteViewer?.name || '';

	const viewerEntry = remoteViewer
		? {
				...remoteViewer,
				name: viewerName,
				color: viewerColor,
				selections: viewerSelections
			}
		: {
				userId: viewer.userId,
				name: viewerName,
				color: viewerColor,
				selections: viewerSelections
			};

	return {
		remoteViewerFound: Boolean(remoteViewer),
		viewerSelections,
		viewerColor,
		allSelections: [...remoteSelections.filter((sel) => sel.userId !== viewer.userId), viewerEntry]
	};
}

/**
 * Convert a participant name into a single badge letter.
 * @param {string} name
 * @returns {string}
 */
export function getParticipantInitial(name) {
	const trimmed = name.trim();
	return (trimmed[0] ?? '?').toUpperCase();
}

/**
 * Convert a hex colour to an rgba() string.
 * @param {string} hex
 * @param {number} opacity
 * @returns {string}
 */
export function colorWithOpacity(hex, opacity) {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `rgba(${r},${g},${b},${opacity})`;
}

/**
 * Compute the current user's selection colours.
 * @param {string} color
 * @param {0|1|2} state
 * @returns {{ background: string; border: string }}
 */
export function getSelectionVisuals(color, state) {
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
 * Filter room selections to the current user plus the selected other users.
 * A null filter means "show everyone".
 *
 * @param {Array<{ userId: string }>} allSelections
 * @param {string} currentUserId
 * @param {string[] | null} selectedOtherUserIds
 * @returns {Array<{ userId: string }>}
 */
export function filterSelectionsByParticipantIds(
	allSelections,
	currentUserId,
	selectedOtherUserIds
) {
	if (!selectedOtherUserIds) {
		return allSelections;
	}

	const selectedIds = new Set(selectedOtherUserIds);
	return allSelections.filter(
		(selection) => selection.userId === currentUserId || selectedIds.has(selection.userId)
	);
}

/**
 * Normalize the locally stored selected-user filter.
 * Null means "show everyone". An empty array means "only me".
 *
 * @param {string[] | null} selectedOtherUserIds
 * @param {string[]} availableOtherUserIds
 * @returns {string[] | null}
 */
export function normalizeSelectedOtherUserIds(selectedOtherUserIds, availableOtherUserIds) {
	if (!selectedOtherUserIds) {
		return null;
	}

	const availableIdSet = new Set(availableOtherUserIds);
	const normalized = [...new Set(selectedOtherUserIds)].filter((userId) =>
		availableIdSet.has(userId)
	);

	return normalized.length === availableOtherUserIds.length ? null : normalized;
}

/**
 * Decide whether a horizontal touch gesture should switch the day view.
 * The gesture only counts when it starts at the relevant edge of the scrollable
 * timetable, so normal panning in the middle never flips days.
 *
 * @param {{
 * 	dx: number
 * 	dy: number
 * 	scrollLeftAtStart: number
 * 	maxScrollLeft: number
 * 	edgeThreshold?: number
 * }} input
 * @returns {boolean}
 */
export function shouldTriggerDaySwipe(input) {
	const edgeThreshold = input.edgeThreshold ?? 16;
	const absDx = Math.abs(input.dx);
	const absDy = Math.abs(input.dy);

	if (!(absDx > 60 && absDy < 100 && absDx > absDy * 1.5)) {
		return false;
	}

	if (input.dx < 0) {
		return input.scrollLeftAtStart >= Math.max(0, input.maxScrollLeft - edgeThreshold);
	}

	return input.scrollLeftAtStart <= edgeThreshold;
}

/**
 * Extract HH:MM from ISO timestamp string (handles +02:00 offset).
 * @param {string} isoStr - e.g. "2026-07-19 00:00:00+02:00"
 * @returns {string} - e.g. "00:00"
 */
function extractTimeFromISO(isoStr) {
	const match = isoStr.match(/(\d{2}):(\d{2}):/);
	if (!match) return '00:00';
	return `${match[1]}:${match[2]}`;
}

/**
 * Format date as "Day, Month Date".
 * @param {string} dateStr - e.g. "2026-07-17"
 * @returns {string}
 */
function formatDateLabel(dateStr) {
	const date = new Date(dateStr + 'T00:00:00Z');
	return new Intl.DateTimeFormat('en-US', {
		weekday: 'long',
		month: 'long',
		day: 'numeric'
	}).format(date);
}

/**
 * Normalize timetable data to internal format.
 * Primavera format (ps26): already normalized, returned as-is.
 * Tomorrowland format (tmr26): converted from raw performances to normalized structure.
 *
 * @param {unknown} rawTimetable
 * @param {string} festivalId - e.g. 'ps26', 'tmr26'
 * @returns {{
 * 	festival: string;
 * 	days: Array<{
 * 		date: string;
 * 		label: string;
 * 		performances: Array<{
 * 			id: string;
 * 			artist: string;
 * 			stage: string;
 * 			startTime: string;
 * 			endTime: string;
 * 			artists?: unknown;
 * 			artistImage?: string;
 * 			instagram?: string;
 * 		}>;
 * 	}>;
 * }}
 */
export function normalizeTimetable(rawTimetable, festivalId) {
	const tbl = rawTimetable ?? {};

	if (festivalId === 'ps26') {
		return tbl;
	}

	if (festivalId === 'tmr26') {
		const performancesByDate = new Map();
		const performances = (tbl.performances ?? []);

		for (const perf of performances) {
			const date = perf.date || '';
			if (!performancesByDate.has(date)) {
				performancesByDate.set(date, []);
			}
			performancesByDate.get(date).push(perf);
		}

		const days = Array.from(performancesByDate.entries())
			.sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
			.map(([date, perfs]) => {
				const sortedPerfs = perfs.sort((a, b) => {
					const timeA = extractTimeFromISO(a.startTime || '');
					const timeB = extractTimeFromISO(b.startTime || '');
					return timeA.localeCompare(timeB);
				});

				return {
					date,
					label: formatDateLabel(date),
					performances: sortedPerfs.map((p) => {
						const firstArtist = (p.artists ?? [])[0];
						return {
							id: p.id || '',
							artist: p.name || '',
							stage: p.stage?.name || '',
							startTime: extractTimeFromISO(p.startTime || ''),
							endTime: extractTimeFromISO(p.endTime || ''),
							...(p.artists && { artists: p.artists }),
							...(firstArtist?.image && { artistImage: firstArtist.image }),
							...(firstArtist?.instagram && { instagram: firstArtist.instagram })
						};
					})
				};
			});

		return {
			festival: tbl.festival || 'Tomorrowland',
			days
		};
	}

	return tbl;
}
