/**
 * @file The Theme contract: no consumer surface may hold a colour literal.
 *
 * Every colour is a `var(--sh-*)` reference, derived from the four public tokens in
 * `src/app.css`. Literals are allowed only in the Fixed block of `app.css` and in the
 * participant palette (`shared/colours.ts`, and the rgba template in `selections.ts`); `rgba(0, 0, 0, …)` backdrops and shadows are
 * allowed anywhere. Admin routes are out of scope and stay hardcoded.
 *
 * It scans source text rather than parsing CSS so it also sees inline `style=` attributes
 * and style strings built in script, which is where orphaned colours hide.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

const FIXED_BLOCK = /\/\* theme:fixed:start \*\/[\s\S]*?\/\* theme:fixed:end \*\//;
// A file may hold several palette regions (the palette, and the rgba() template for it).
const PALETTE_REGION = /\/\/ theme:palette:start[\s\S]*?\/\/ theme:palette:end/g;
// The four public tokens' default values are the one themed declaration that is a literal.
const PUBLIC_TOKEN_DEFAULT = /^\s*--sh-(?:bg|surface|text|accent):.*$/gm;

const NAMED_COLOURS = [
	'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black',
	'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse',
	'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan',
	'darkgoldenrod', 'darkgray', 'darkgrey', 'darkgreen', 'darkkhaki', 'darkmagenta',
	'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen',
	'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink',
	'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen',
	'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'grey', 'green',
	'greenyellow', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender',
	'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan',
	'lightgoldenrodyellow', 'lightgray', 'lightgrey', 'lightgreen', 'lightpink', 'lightsalmon',
	'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue',
	'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine',
	'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue',
	'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream',
	'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange',
	'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred',
	'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple',
	'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell',
	'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen',
	'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white',
	'whitesmoke', 'yellow', 'yellowgreen'
];

const LITERAL = new RegExp(
	[
		'#[0-9a-fA-F]{3,8}\\b',
		'\\b(?:rgba?|hsla?)\\(',
		`(?<![\\w-])(?:${NAMED_COLOURS.join('|')})(?![\\w-])`
	].join('|'),
	'g'
);
const BACKDROP = /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/;
// Named colours only count where a colour is expected: a CSS value or a quoted style string.
const NAMED_ONLY = new RegExp(`^(?:${NAMED_COLOURS.join('|')})$`);

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

function inScope(path: string): boolean {
	const rel = relative(SRC, path).split(sep).join('/');
	if (rel.startsWith('routes/admin/')) return false;
	if (rel.endsWith('.spec.ts')) return false;
	if (rel === 'app.css') return true;
	if (rel.endsWith('.svelte')) return true;
	return rel.startsWith('lib/') && rel.endsWith('.ts');
}

const blank = (m: string) => m.replace(/[^\n]/g, ' ');

/** Blank out comments (prose says "red", "white") and the exempt regions, keeping line numbers. */
function stripped(path: string, text: string): string {
	// Exempt regions first: their markers are themselves comments.
	let out = text;
	if (path.endsWith('app.css'))
		out = out.replace(FIXED_BLOCK, blank).replace(PUBLIC_TOKEN_DEFAULT, blank);
	if (path.endsWith('selections.ts')) out = out.replace(PALETTE_REGION, blank);
	out = out.replace(/\/\*[\s\S]*?\*\//g, blank);
	out = out.replace(/<!--[\s\S]*?-->/g, blank);
	return out.replace(/(^|[^:])\/\/[^\n]*/g, (m, p: string) => p + ' '.repeat(m.length - p.length));
}

/**
 * Only the parts of a file that can hold a colour: the `<style>` block, `style=` values,
 * and script strings. Markup text ("Red Stage") is not a colour, so for `.svelte` files
 * named colours are matched only inside a `property: value` position.
 */
function findLiterals(path: string): string[] {
	const clean = stripped(path, readFileSync(path, 'utf8'));
	const rel = relative(SRC, path).split(sep).join('/');
	const hits: string[] = [];
	for (const m of clean.matchAll(LITERAL)) {
		const at = m.index!;
		if (BACKDROP.test(clean.slice(at, at + 24))) continue;
		if (NAMED_ONLY.test(m[0])) {
			const before = clean.slice(Math.max(0, at - 40), at);
			if (!/[a-z-]+\s*:\s*[^;{}\n]*$/i.test(before)) continue;
		}
		hits.push(`${rel}:${clean.slice(0, at).split('\n').length} ${m[0]}`);
	}
	return hits;
}

describe('theme contract', () => {
	it('has no colour literals outside the Fixed block and the participant palette', () => {
		const hits = walk(SRC).filter(inScope).flatMap(findLiterals);
		expect(hits).toEqual([]);
	});

	it('declares the four public tokens with today’s defaults', () => {
		const css = readFileSync(join(SRC, 'app.css'), 'utf8');
		const root = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
		expect(root).toMatch(/--sh-bg:\s*#1a1a1a;/);
		expect(root).toMatch(/--sh-surface:\s*#2a2a2a;/);
		expect(root).toMatch(/--sh-text:\s*#fffaf0;/);
		expect(root).toMatch(/--sh-accent:\s*#e74c3c;/);
	});
});
