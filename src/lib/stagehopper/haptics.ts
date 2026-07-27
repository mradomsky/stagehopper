/**
 * @file Tiny haptic tick for touch interactions, where the device supports it.
 */

const TICK_MS = 12;

export function haptic(): void {
	if (typeof navigator === 'undefined' || !navigator.vibrate) return;
	navigator.vibrate(TICK_MS);
}
