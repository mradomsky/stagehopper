import { describe, expect, it } from 'vitest';

describe('routes', () => {
	// An unmatched path is a bare 404 in the app: no redirect, no page (#211, spec #203).
	it('has no page or layout under /room or /admin/rooms', () => {
		const files = Object.keys(import.meta.glob('./**/+{page,layout}*.svelte'));
		expect(files.filter((f) => /^\.\/(admin\/)?rooms?\//.test(f))).toEqual([]);
	});
});
