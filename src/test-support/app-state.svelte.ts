/**
 * @file A reactive stand-in for SvelteKit's `$app/state`, for route component tests.
 *
 * `page` must be rune-backed: the room route reads `page.params.roomId` inside an
 * `$effect`, so a plain object would never re-trigger it and the route-change path
 * would go untested. Not imported by app code, so it never ships.
 */

interface MockPage {
	params: Record<string, string>;
	url: URL;
}

export const mockPage: MockPage = $state({
	params: {},
	url: new URL('http://localhost/')
});

/** Point the mock page at a route; omitted parts are left as they were. */
export function setMockPage(next: { params?: Record<string, string>; url?: string }): void {
	if (next.params) mockPage.params = next.params;
	if (next.url) mockPage.url = new URL(next.url);
}

/** Restore the empty starting state between tests. */
export function resetMockPage(): void {
	mockPage.params = {};
	mockPage.url = new URL('http://localhost/');
}
