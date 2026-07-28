/**
 * @file Client-side downscale for a festival cover image before it's uploaded.
 *
 * A phone photo can be several megabytes; nothing on a festival card needs more than
 * {@link MAX_IMAGE_DIMENSION}px on its long edge. Downscaling here keeps that off the
 * wire entirely, rather than uploading it full-size and hoping to shrink it later.
 */

export const MAX_IMAGE_DIMENSION = 1600;
export const IMAGE_OUTPUT_TYPE = 'image/jpeg';
export const IMAGE_OUTPUT_QUALITY = 0.85;

/** The size an image should be drawn at so neither edge exceeds `maxDimension`. */
export function computeDownscaledSize(
	width: number,
	height: number,
	maxDimension: number = MAX_IMAGE_DIMENSION
): { width: number; height: number } {
	if (width <= maxDimension && height <= maxDimension) return { width, height };
	const scale = maxDimension / Math.max(width, height);
	return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

async function decodeImage(file: File): Promise<ImageBitmap | null> {
	if (typeof createImageBitmap !== 'function') return null;
	try {
		return await createImageBitmap(file);
	} catch {
		return null;
	}
}

/**
 * Downscale an image file to a JPEG no larger than {@link MAX_IMAGE_DIMENSION} on its
 * long edge. Falls back to the original file untouched whenever the browser can't
 * decode or re-encode it — a full-size upload beats no upload at all.
 */
export async function downscaleImage(file: File): Promise<Blob> {
	const bitmap = await decodeImage(file);
	if (!bitmap) return file;

	try {
		const { width, height } = computeDownscaledSize(bitmap.width, bitmap.height);
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d');
		if (!ctx) return file;

		ctx.drawImage(bitmap, 0, 0, width, height);
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, IMAGE_OUTPUT_TYPE, IMAGE_OUTPUT_QUALITY)
		);
		return blob ?? file;
	} finally {
		bitmap.close();
	}
}
