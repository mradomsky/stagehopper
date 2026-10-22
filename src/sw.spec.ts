// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

/** Run static/sw.js against a stub worker scope and hand back the handlers it registered. */
function loadWorker() {
	const handlers: Record<string, (event: unknown) => void> = {};
	const openWindow = vi.fn().mockResolvedValue(undefined);
	const self = {
		addEventListener: (type: string, handler: (event: unknown) => void) => {
			handlers[type] = handler;
		},
		clients: { matchAll: vi.fn().mockResolvedValue([]), openWindow },
		skipWaiting: vi.fn()
	};
	const source = readFileSync('static/sw.js', 'utf8');
	new Function('self', 'caches', source)(self, {});
	return { handlers, openWindow };
}

async function tap(data: Record<string, unknown>): Promise<string> {
	const { handlers, openWindow } = loadWorker();
	let pending: Promise<unknown> = Promise.resolve();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	handlers.notificationclick!({
		notification: { close: vi.fn(), data },
		waitUntil: (p: Promise<unknown>) => (pending = p)
	});
	await pending;
	return openWindow.mock.calls[0]![0] as string;
}

describe('notification tap target', () => {
	it('opens the Festival anchored to the Performance', async () => {
		expect(await tap({ festivalId: 'tmr26', performanceId: 'p1' })).toBe('/festival/tmr26#perf-p1');
	});

	it('opens the home page for a legacy payload that names only a roomId', async () => {
		expect(await tap({ roomId: 'tmr26-abc123', performanceId: 'p1' })).toBe('/');
	});
});
