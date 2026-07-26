import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

/**
 * Node 24 exposes its own experimental `localStorage` global, which shadows jsdom's
 * and throws unless the process was started with `--localstorage-file`. Install a
 * plain in-memory implementation so storage-backed code under test behaves like a
 * browser's, regardless of which global won.
 */
class MemoryStorage implements Storage {
	#entries = new Map<string, string>();

	get length(): number {
		return this.#entries.size;
	}

	key(index: number): string | null {
		return [...this.#entries.keys()][index] ?? null;
	}

	getItem(key: string): string | null {
		return this.#entries.get(String(key)) ?? null;
	}

	setItem(key: string, value: string): void {
		this.#entries.set(String(key), String(value));
	}

	removeItem(key: string): void {
		this.#entries.delete(String(key));
	}

	clear(): void {
		this.#entries.clear();
	}
}

const storage = new MemoryStorage();
for (const target of [globalThis, globalThis.window]) {
	if (!target) continue;
	Object.defineProperty(target, 'localStorage', {
		value: storage,
		writable: true,
		configurable: true
	});
}

/** Keep room-scoped storage tests independent of each other. */
afterEach(() => {
	localStorage.clear();
});
