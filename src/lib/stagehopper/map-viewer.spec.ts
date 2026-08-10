import { describe, expect, it } from 'vitest';
import { clampPan, clampScale, fitScale } from './map-viewer.js';

describe('fitScale', () => {
	it('returns the contain-fit scale', () => {
		expect(fitScale(400, 300, 800, 600)).toBeCloseTo(2);
		expect(fitScale(800, 600, 400, 300)).toBeCloseTo(0.5);
	});

	it('accounts for aspect ratio mismatch', () => {
		expect(fitScale(1000, 500, 400, 400)).toBeCloseTo(0.4);
		expect(fitScale(500, 1000, 400, 400)).toBeCloseTo(0.4);
	});

	it('returns 1 for invalid dimensions', () => {
		expect(fitScale(0, 0, 100, 100)).toBe(1);
		expect(fitScale(100, 100, 0, 0)).toBe(1);
		expect(fitScale(-100, 100, 100, 100)).toBe(1);
	});
});

describe('clampScale', () => {
	it('clamps to min', () => {
		expect(clampScale(0.5, 1, 4)).toBe(1);
	});

	it('clamps to max', () => {
		expect(clampScale(5, 1, 4)).toBe(4);
	});

	it('passes through in-range values', () => {
		expect(clampScale(2, 1, 4)).toBe(2);
	});
});

describe('clampPan', () => {
	it('centers image when smaller than viewport', () => {
		const result = clampPan({ scale: 0.5, x: -100, y: -200 }, 400, 300, 800, 600);
		expect(result.x).toBe((800 - 400 * 0.5) / 2);
		expect(result.y).toBe((600 - 300 * 0.5) / 2);
	});

	it('prevents panning past edges when larger than viewport', () => {
		const result = clampPan({ scale: 2, x: 0, y: 0 }, 400, 300, 800, 600);
		expect(result.x).toBeLessThanOrEqual(0);
		expect(result.x).toBeGreaterThanOrEqual(-400 * 2 + 800);
		expect(result.y).toBeLessThanOrEqual(0);
		expect(result.y).toBeGreaterThanOrEqual(-300 * 2 + 600);
	});

	it('allows panning within valid range', () => {
		const start = { scale: 3, x: -200, y: -100 };
		const result = clampPan(start, 400, 300, 800, 600);
		expect(result.x).toBe(-200);
		expect(result.y).toBe(-100);
	});
});
