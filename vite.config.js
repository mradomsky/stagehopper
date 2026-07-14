import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { execSync } from 'child_process';

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
	plugins: [sveltekit()]
});
