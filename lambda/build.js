/**
 * Bundle the Lambda into a single ESM file for deployment.
 *
 * Bundling (rather than zipping node_modules) keeps the upload in the low megabytes
 * instead of ~40 MB, and pins the exact dependency code that was tested.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

await build({
	entryPoints: [join(here, 'index.ts')],
	outfile: join(here, 'dist', 'index.mjs'),
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'esm',
	sourcemap: false,
	minify: false,
	// Some bundled dependencies still reach for CommonJS `require` at runtime; ESM
	// output has no `require`, so provide one built from the module URL.
	banner: {
		js: [
			"import { createRequire as __createRequire } from 'node:module';",
			'const require = __createRequire(import.meta.url);'
		].join('\n')
	},
	logLevel: 'info'
});
