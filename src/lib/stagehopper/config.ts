/**
 * Runtime config: where the SPA reaches its API and its published JSON, and the
 * localStorage namespace. Defaults are the same-origin paths the app has always used;
 * a host that serves the bundle from another origin calls {@link configure} once at
 * startup. Consumers read through the getters at call time, never at import time.
 */

const DEFAULT_API_BASE = '/api/stagehopper';
export const DEFAULT_DATA_BASE = '/data';

/** Namespace for every localStorage key (auth, Picks and view state alike). Not overridable. */
export const STORAGE_PREFIX = 'stagehopper';

let apiBaseValue = DEFAULT_API_BASE;
let dataBaseValue = DEFAULT_DATA_BASE;

export interface RuntimeConfig {
	/** Prefix of every API route, e.g. `https://host/api/stagehopper`. */
	apiBase: string;
	/** Prefix of the published data files, e.g. `https://host/data`. */
	dataBase: string;
}

export function configure(overrides: Partial<RuntimeConfig>): void {
	if (overrides.apiBase !== undefined) apiBaseValue = overrides.apiBase;
	if (overrides.dataBase !== undefined) dataBaseValue = overrides.dataBase;
}

/** Back to the defaults; for tests. */
export function resetConfig(): void {
	apiBaseValue = DEFAULT_API_BASE;
	dataBaseValue = DEFAULT_DATA_BASE;
}

export const apiBase = (): string => apiBaseValue;
export const dataBase = (): string => dataBaseValue;
