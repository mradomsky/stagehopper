import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import { execSync } from 'node:child_process';

const commit = (() => {
	try {
		return execSync('git rev-parse --short HEAD').toString().trim();
	} catch {
		return 'dev';
	}
})();

export default defineConfig({
	define: {
		'import.meta.env.VITE_COMMIT': JSON.stringify(commit)
	},
	plugins: [sveltekit()],
	// Under Vitest, resolve Svelte to its browser build so components can be mounted
	// into jsdom instead of being server-rendered.
	resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
	test: {
		environment: 'jsdom',
		// Testing Library hooks its automatic DOM cleanup onto the global afterEach.
		globals: true,
		setupFiles: ['./vitest-setup.ts'],
		include: ['src/**/*.spec.ts', 'lambda/**/*.spec.ts'],
		exclude: ['**/node_modules/**', 'build/**', '.svelte-kit/**']
	}
});
