import { describe, expect, it } from 'vitest';
import { computeDownscaledSize, downscaleImage, MAX_IMAGE_DIMENSION } from './image-upload.js';

describe('computeDownscaledSize', () => {
	it('leaves an image that already fits untouched', () => {
		expect(computeDownscaledSize(800, 600)).toEqual({ width: 800, height: 600 });
	});

	it('leaves an image exactly at the limit untouched', () => {
		expect(computeDownscaledSize(MAX_IMAGE_DIMENSION, 900)).toEqual({
			width: MAX_IMAGE_DIMENSION,
			height: 900
		});
	});

	it('scales a landscape image down to the limit on its long edge', () => {
		expect(computeDownscaledSize(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
	});

	it('scales a portrait image down to the limit on its long edge', () => {
		expect(computeDownscaledSize(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
	});

	it('scales a square image to a square', () => {
		expect(computeDownscaledSize(5000, 5000, 1600)).toEqual({ width: 1600, height: 1600 });
	});
});

describe('downscaleImage', () => {
	it('falls back to the original file when the browser cannot decode images', async () => {
		// jsdom has no createImageBitmap, exactly the environment this fallback exists for.
		const file = new File(['pretend-image-bytes'], 'photo.jpg', { type: 'image/jpeg' });

		const result = await downscaleImage(file);

		expect(result).toBe(file);
	});
});
