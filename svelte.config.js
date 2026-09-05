import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			fallback: 'index.html'
		}),
		// Wire-shape modules shared with the Lambda bundles (see shared/festival-fields.ts).
		alias: { $shared: 'shared' }
	}
};

export default config;
