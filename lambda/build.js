/**
 * Bundle Lambda functions into single ESM files for deployment.
 *
 * Bundling (rather than zipping node_modules) keeps uploads in the low megabytes
 * instead of ~40 MB, and pins the exact dependency code that was tested.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const bannerJs = [
	"import { createRequire as __createRequire } from 'node:module';",
	'const require = __createRequire(import.meta.url);'
].join('\n');

const commonOptions = {
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'esm',
	sourcemap: false,
	minify: false,
	banner: { js: bannerJs },
	logLevel: 'info'
};

// Build API Lambda
await build({
	...commonOptions,
	entryPoints: [join(here, 'index.ts')],
	outfile: join(here, 'dist', 'index.mjs')
});

// Build Notifier Lambda
await build({
	...commonOptions,
	entryPoints: [join(here, 'notifier.ts')],
	outfile: join(here, 'dist', 'notifier.mjs')
});
