/**
 * @file The three room panels, shared by the top nav and the mobile bottom bar.
 */

import type { ViewMode } from './types.js';

export interface ViewModeOption {
	id: ViewMode;
	/** Label in the desktop nav. */
	label: string;
	/** Label in the mobile bottom bar, which leads with an icon. */
	mobileLabel: string;
}

export const VIEW_MODES: ViewModeOption[] = [
	{ id: 'full', label: 'Timetable', mobileLabel: '⊞ Timetable' },
	{ id: 'liked', label: '♥ Liked', mobileLabel: '♥ Liked' }
];
