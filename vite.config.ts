import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import { execSync } from 'node:child_process';

// Prod deploys run on a release tag (see deploy.yml), so at build time HEAD is that
// exact tag and `git describe` yields a clean `v1.2.0`. Off a tag it degrades to
// `v1.2.0-3-g<sha>` (or the bare sha with no tags at all); outside a checkout, `dev`.
const version = (() => {
	try {
		return execSync('git describe --tags --always').toString().trim();
	} catch {
		return 'dev';
	}
})();

export default defineConfig({
	define: {
		'import.meta.env.VITE_VERSION': JSON.stringify(version)
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
		include: ['src/**/*.spec.ts', 'lambda/**/*.spec.ts', 'shared/**/*.spec.ts'],
		exclude: ['**/node_modules/**', 'build/**', '.svelte-kit/**']
	}
});
