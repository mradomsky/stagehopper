import { describe, expect, it } from 'vitest';

describe('routes', () => {
	// An unmatched path is a bare 404 in the app: no redirect, no page (#211, spec #203).
	it('has no page or layout under /room or /admin/rooms', () => {
		const files = Object.keys(import.meta.glob('./**/+{page,layout}*.svelte'));
		expect(files.filter((f) => /^\.\/(admin\/)?rooms?\//.test(f))).toEqual([]);
	});

	// A catch-all would serve /room/x as a page, which is not the bare 404 the spec asks for.
	it('has no catch-all route that could answer /room/x', () => {
		const files = Object.keys(import.meta.glob('./**/+{page,layout}*.svelte'));
		expect(files.filter((f) => f.includes('[...'))).toEqual([]);
	});
});
