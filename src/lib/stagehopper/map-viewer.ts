/**
 * @file Pure math for festival map pinch/pan/zoom interactions.
 * No DOM or events — the component handles those and drives state with these functions.
 */

export interface ViewportTransform {
	scale: number;
	x: number;
	y: number;
}

/**
 * Calculate the scale that fits the image contain-style inside the viewport.
 * Returns min(viewW / imgW, viewH / imgH).
 */
export function fitScale(imgW: number, imgH: number, viewW: number, viewH: number): number {
	if (imgW <= 0 || imgH <= 0 || viewW <= 0 || viewH <= 0) return 1;
	return Math.min(viewW / imgW, viewH / imgH);
}

/** Clamp scale between min and max bounds (inclusive). */
export function clampScale(scale: number, minScale: number, maxScale: number): number {
	return Math.max(minScale, Math.min(scale, maxScale));
}

/**
 * Clamp pan offsets so the scaled image doesn't drift entirely out of view.
 * When the scaled image is smaller than the viewport on an axis, center it.
 */
export function clampPan(
	transform: ViewportTransform,
	imgW: number,
	imgH: number,
	viewW: number,
	viewH: number
): ViewportTransform {
	const scaledW = imgW * transform.scale;
	const scaledH = imgH * transform.scale;

	let x = transform.x;
	let y = transform.y;

	// Clamp horizontal pan: keep the image from drifting off-screen horizontally.
	if (scaledW > viewW) {
		// Image is wider than viewport: don't let it pan past its edges.
		x = Math.max(-scaledW + viewW, Math.min(0, x));
	} else {
		// Image is narrower than viewport: center it horizontally.
		x = (viewW - scaledW) / 2;
	}

	// Clamp vertical pan: keep the image from drifting off-screen vertically.
	if (scaledH > viewH) {
		// Image is taller than viewport: don't let it pan past its edges.
		y = Math.max(-scaledH + viewH, Math.min(0, y));
	} else {
		// Image is shorter than viewport: center it vertically.
		y = (viewH - scaledH) / 2;
	}

	return { ...transform, x, y };
}
