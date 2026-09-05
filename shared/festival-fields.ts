/**
 * @file The Festival record schema — the one place a festival field is declared.
 *
 * Imported by both the Lambda (`lambda/`) and the SPA (`src/`, via `$shared`). Everything
 * that used to be a hand-kept list derives from {@link FESTIVAL_FIELDS}:
 *
 * - the strict write-side validator ({@link validateFestivalRecord}),
 * - the loose read-side shape guard the SPA applies to the published manifest
 *   ({@link isFestivalRecord}),
 * - the manifest projection that whitelists a DynamoDB row into a public entry
 *   ({@link toManifestEntry}).
 *
 * The compiler enforces the table against the interface in both directions: a key in
 * {@link FestivalRecord} with no spec, or a spec for a key not on the interface, is a type
 * error. That closes CLAUDE.md trap 3 (`mapUrl` stored and previewed but never published)
 * at the source instead of in a per-field test.
 *
 * No runtime dependencies: this file must bundle into both a Lambda and the browser.
 */

/**
 * A festival as stored in `stagehopper-festivals` (DynamoDB), edited by the admin form, and
 * published verbatim to `data/festivals/index.json`. Every field is public. `id` is
 * write-once: every room id permanently embeds it as a prefix, so changing an existing one
 * would orphan every room already created under it.
 */
export interface FestivalRecord {
	id: string;
	name: string;
	location: string;
	/** ISO date, e.g. `2026-07-17`. */
	startDate: string;
	/** ISO date, e.g. `2026-07-20`. */
	endDate: string;
	/**
	 * IANA timezone, e.g. `Europe/Berlin`. Required on every write (the notifier converts
	 * wall-clock set times to UTC with it), but legacy rows predate the field, so it is
	 * optional on read and defaulted to `Europe/Berlin` by every reader.
	 */
	timezone?: string;
	/** Cover image for the landing card. Absent falls back to a neutral placeholder. */
	imageUrl?: string;
	/** Uploaded festival map image. Absent hides the Map menu entry. */
	mapUrl?: string;
	/** Plain text, shown on the festival detail page. Max {@link MAX_FESTIVAL_DESCRIPTION_LENGTH} characters. */
	description?: string;
	/**
	 * Stage name → `#rrggbb` colour, admin-set per stage. A stage with no entry (or an
	 * absent map) renders with the default neutral timetable styling. Keyed by the stage
	 * name as it appears on performances — there's no separate managed stage list.
	 */
	stageColors?: Record<string, string>;
	/**
	 * Admin-set stage display order, front to back. Stages the timetable knows about but
	 * this list doesn't mention render after it, in first-appearance order — see
	 * `resolveStageOrder` in the app's `timetable.ts`.
	 */
	stageOrder?: string[];
}

export const FESTIVAL_ID_REGEX = /^[a-z0-9]{2,10}$/;
export const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
export const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
export const MAX_FESTIVAL_DESCRIPTION_LENGTH = 1000;

/**
 * The runtime shape of a field, as far as the loose read-side guard cares. The SPA
 * rejects a published entry only when a field is the wrong *kind* of value; anything
 * stricter (regexes, caps, timezone validity) is the writer's job.
 */
export type FieldKind = 'string' | 'stringArray' | 'stringMap';

export interface FieldSpec {
	kind: FieldKind;
	/**
	 * `true` when a write must carry the field even though the type marks it optional —
	 * the legacy-row case. Fields that are required on the type are required on write
	 * regardless.
	 */
	requiredOnWrite?: true;
	/**
	 * Strict per-value check applied on write only, once the value is present and of the
	 * right kind. Returns the exact error message the admin sees, or `null`.
	 */
	check?: (value: never) => string | null;
	/** Message when a required field is missing or of the wrong kind. */
	missing: string;
}

/** Maps `FieldKind` to the TypeScript type `check` receives. */
type KindValue<K extends FieldKind> = K extends 'string'
	? string
	: K extends 'stringArray'
		? string[]
		: Record<string, string>;

type SpecFor<K extends FieldKind> = Omit<FieldSpec, 'check' | 'kind'> & {
	kind: K;
	check?: (value: KindValue<K>) => string | null;
};

/**
 * `satisfies` target: every key of {@link FestivalRecord} exactly once, no extras. `-?`
 * strips the optionality so an optional field still needs a spec.
 */
type AnySpec = { [K in FieldKind]: SpecFor<K> }[FieldKind];
type FieldSpecs = { [K in keyof FestivalRecord]-?: AnySpec };

/** Which keys of {@link FestivalRecord} are optional on the type. */
type OptionalKeys = {
	[K in keyof FestivalRecord]-?: undefined extends FestivalRecord[K] ? K : never;
}[keyof FestivalRecord];

function str<K extends FieldKind>(kind: K, spec: Omit<SpecFor<K>, 'kind'>): SpecFor<K> {
	return { kind, ...spec } as SpecFor<K>;
}

/**
 * Whether a string is an IANA timezone the runtime recognizes. `Intl.DateTimeFormat`
 * throws `RangeError` on an unknown zone, so a successful construction is the check —
 * cheaper and more future-proof than diffing against `Intl.supportedValuesOf`.
 */
export function isValidTimeZone(tz: string): boolean {
	if (!tz) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

function nonBlank(field: string): (value: string) => string | null {
	return (value) => (value.trim().length === 0 ? `${field} is required` : null);
}

function isoDate(field: string): (value: string) => string | null {
	return (value) => (ISO_DATE_REGEX.test(value) ? null : `${field} must be an ISO date (YYYY-MM-DD)`);
}

/** Shared by the record validator and the dedicated stage-order patch endpoint. */
export function validateStageOrder(value: unknown): string | null {
	if (!Array.isArray(value)) return 'stageOrder must be an array';
	if (value.some((name) => typeof name !== 'string' || name.trim().length === 0)) {
		return 'stageOrder must be an array of non-empty strings';
	}
	return null;
}

/**
 * The schema. Order matters only for which error an invalid record reports first, which
 * the admin form shows one at a time — keep it in the order the form lays fields out.
 */
export const FESTIVAL_FIELDS = {
	id: str('string', {
		missing: 'festival id must be 2-10 lowercase letters/digits',
		check: (v) => (FESTIVAL_ID_REGEX.test(v) ? null : 'festival id must be 2-10 lowercase letters/digits')
	}),
	name: str('string', { missing: 'name is required', check: nonBlank('name') }),
	location: str('string', { missing: 'location is required', check: nonBlank('location') }),
	startDate: str('string', {
		missing: 'startDate must be an ISO date (YYYY-MM-DD)',
		check: isoDate('startDate')
	}),
	endDate: str('string', {
		missing: 'endDate must be an ISO date (YYYY-MM-DD)',
		check: isoDate('endDate')
	}),
	timezone: str('string', {
		requiredOnWrite: true,
		missing: 'timezone must be a valid IANA timezone',
		check: (v) => (isValidTimeZone(v) ? null : 'timezone must be a valid IANA timezone')
	}),
	imageUrl: str('string', { missing: 'imageUrl must be a string' }),
	mapUrl: str('string', { missing: 'mapUrl must be a string' }),
	description: str('string', {
		missing: 'description must be a string',
		check: (v) =>
			v.length > MAX_FESTIVAL_DESCRIPTION_LENGTH
				? `description must be at most ${MAX_FESTIVAL_DESCRIPTION_LENGTH} characters`
				: null
	}),
	stageColors: str('stringMap', {
		missing: 'stageColors must be an object',
		check: (map) => {
			// Kind checks are shape-only, so values may still be non-strings here.
			for (const [stage, color] of Object.entries(map as Record<string, unknown>)) {
				if (stage.trim().length === 0) return 'stageColors keys must not be empty';
				if (typeof color !== 'string' || !HEX_COLOR_REGEX.test(color)) return `stageColors["${stage}"] must be a #rrggbb colour`;
			}
			return null;
		}
	}),
	stageOrder: str('stringArray', {
		missing: 'stageOrder must be an array',
		check: (list) => validateStageOrder(list)
	})
} satisfies FieldSpecs;

export type FestivalField = keyof typeof FESTIVAL_FIELDS;

/** Every field name, in schema order. The manifest projection and tests iterate this. */
export const FESTIVAL_FIELD_NAMES = Object.keys(FESTIVAL_FIELDS) as FestivalField[];

/**
 * Compile-time check that `requiredOnWrite` is only ever set on fields the type marks
 * optional; a required field is required on write by construction.
 */
type RequiredOnWriteKeys = {
	[K in FestivalField]: (typeof FESTIVAL_FIELDS)[K] extends { requiredOnWrite: true } ? K : never;
}[FestivalField];
const _requiredOnWriteAreOptionalOnType: RequiredOnWriteKeys extends OptionalKeys ? true : never = true;
void _requiredOnWriteAreOptionalOnType;

const REQUIRED_ON_TYPE: ReadonlySet<FestivalField> = new Set<FestivalField>([
	'id',
	'name',
	'location',
	'startDate',
	'endDate'
]);
// Compile-time: the set above must name exactly the non-optional keys.
const _requiredMatchesType: Exclude<FestivalField, OptionalKeys> extends
	| 'id'
	| 'name'
	| 'location'
	| 'startDate'
	| 'endDate'
	? true
	: never = true;
void _requiredMatchesType;

/**
 * Whether `value` is the right kind of value for a field, ignoring every stricter rule.
 * This is the entire contract the SPA applies to a published manifest entry, so it must
 * stay permissive: a stricter rule here would let one odd row knock the whole live list
 * back to the compiled defaults.
 */
function matchesKind(kind: FieldKind, value: unknown): boolean {
	switch (kind) {
		case 'string':
			return typeof value === 'string';
		case 'stringArray':
			return Array.isArray(value);
		case 'stringMap':
			return typeof value === 'object' && value !== null && !Array.isArray(value);
	}
}

function isRequiredOnWrite(field: FestivalField): boolean {
	return REQUIRED_ON_TYPE.has(field) || FESTIVAL_FIELDS[field].requiredOnWrite === true;
}

export type ValidationResult = { record: FestivalRecord; error?: never } | { record?: never; error: string };

/**
 * Strict write-side validation. Every non-empty string field is trimmed-non-empty, not
 * merely present: an admin pasting a blank name would otherwise silently break the
 * landing page for every visitor, not just the person who made the mistake.
 *
 * On success returns a **new** record holding only schema fields — unknown keys in the
 * body are dropped, so a DynamoDB row can never carry anything the manifest doesn't.
 */
export function validateFestivalRecord(value: unknown): ValidationResult {
	if (!value || typeof value !== 'object') return { error: 'each festival must be an object' };
	const input = value as Record<string, unknown>;
	const record: Record<string, unknown> = {};

	for (const field of FESTIVAL_FIELD_NAMES) {
		const spec = FESTIVAL_FIELDS[field] as FieldSpec;
		const raw = input[field];
		if (raw === undefined) {
			if (isRequiredOnWrite(field)) return { error: spec.missing };
			continue;
		}
		if (!matchesKind(spec.kind, raw)) return { error: spec.missing };
		const check = spec.check as ((v: unknown) => string | null) | undefined;
		const checkError = check?.(raw);
		if (checkError) return { error: checkError };
		record[field] = raw;
	}

	// Cross-field rules live after the per-field pass so their inputs are already typed.
	const typed = record as unknown as FestivalRecord;
	if (typed.startDate > typed.endDate) return { error: 'startDate must not be after endDate' };

	return { record: typed };
}

/**
 * Loose read-side guard for a published manifest entry: required-on-type fields present
 * and every present field of the right kind. Deliberately tolerates a missing `timezone`
 * (legacy rows) and applies none of the write-side rules.
 */
export function isFestivalRecord(value: unknown): value is FestivalRecord {
	if (!value || typeof value !== 'object') return false;
	const input = value as Record<string, unknown>;
	for (const field of FESTIVAL_FIELD_NAMES) {
		const raw = input[field];
		if (raw === undefined) {
			if (REQUIRED_ON_TYPE.has(field)) return false;
			continue;
		}
		if (!matchesKind(FESTIVAL_FIELDS[field].kind, raw)) return false;
	}
	return true;
}

/**
 * Project a DynamoDB row onto the public manifest entry: schema fields only, in schema
 * order. Returns `null` when the row fails {@link isFestivalRecord}; the publisher skips
 * and logs it rather than coercing (which hid corruption) or failing the whole manifest
 * (which would punish every festival for one bad row).
 */
export function toManifestEntry(item: Record<string, unknown>): FestivalRecord | null {
	if (!isFestivalRecord(item)) return null;
	const entry: Record<string, unknown> = {};
	for (const field of FESTIVAL_FIELD_NAMES) {
		const raw = (item as Record<string, unknown>)[field];
		if (raw !== undefined) entry[field] = raw;
	}
	return entry as unknown as FestivalRecord;
}
