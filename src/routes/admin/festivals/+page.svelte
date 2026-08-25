<script lang="ts">
	/**
	 * Festival list plus create/edit form, against `stagehopper-festivals` in DynamoDB.
	 *
	 * Reads go through `GET /admin/festivals`, which scans the table directly. The landing
	 * page still fetches the public, slim manifest off CloudFront — that copy should stay
	 * cached — but an editor reading an edge copy races its own just-saved write. The route
	 * could not exist while the credential travelled in a request body, because `fetch`
	 * refuses to send one on a GET.
	 *
	 * Create/update/delete are per-record — `POST`, `PATCH /{id}`, `DELETE /{id}` — so
	 * saving one festival never touches any other, unlike the old bulk-replace endpoint.
	 * The id is generated on create and frozen on every later edit, since it's baked into
	 * every room id already created under it.
	 */
	import { onMount } from 'svelte';
	import Modal from '$lib/stagehopper/components/Modal.svelte';
	import ConfirmDialog from '$lib/stagehopper/components/ConfirmDialog.svelte';
	import {
		createFestival,
		deleteFestival,
		fetchAdminFestivals,
		importFestivalTimetable,
		presignFestivalImage,
		presignFestivalMap,
		updateFestival,
		uploadToPresignedUrl
	} from '$lib/stagehopper/api.js';
	import { downscaleImage } from '$lib/stagehopper/admin/image-upload.js';
	import { DEFAULT_FESTIVALS } from '$lib/stagehopper/festivals.svelte.js';
	import { buildStageOrder, fetchTimetableForFestival } from '$lib/stagehopper/timetable.js';
	import {
		buildTimetablePreview,
		validateTimetableImport,
		type TimetablePreview
	} from '$lib/stagehopper/timetable-import.js';
	import type { FestivalRecord, TimetableUpload } from '$lib/stagehopper/types.js';

	/** Errors beyond this are summarized rather than listed — a wholesale-wrong file
	 * doesn't need a 200-line list. */
	const MAX_SHOWN_IMPORT_ERRORS = 15;

	/** Must match the Lambda's `FESTIVAL_ID_REGEX`; the id is write-once and admin-set. */
	const FESTIVAL_ID_REGEX = /^[a-z0-9]{2,10}$/;

	let festivals = $state<FestivalRecord[]>([]);
	let loading = $state(true);
	let loadError = $state('');
	let saveError = $state('');
	let saving = $state(false);
	/** Set after a save/delete that landed but whose publish to the public site failed. */
	let publishWarning = $state('');

	let editing = $state<FestivalRecord | null>(null);
	let isNew = $state(false);
	let deleteTarget = $state<FestivalRecord | null>(null);

	let uploadingImage = $state(false);
	let uploadError = $state('');

	let uploadingMap = $state(false);
	let mapError = $state('');

	let stageColorsOpen = $state(false);
	let stageColorsLoading = $state(false);
	let stageColorsError = $state('');
	let stageNames = $state<string[]>([]);

	let importTarget = $state<FestivalRecord | null>(null);
	let importParsed = $state<TimetableUpload | null>(null);
	let importPreview = $state<TimetablePreview | null>(null);
	let importErrors = $state<string[]>([]);
	let importing = $state(false);
	let importError = $state('');

	function blankRecord(): FestivalRecord {
		return {
			id: '',
			name: '',
			location: '',
			startDate: '',
			endDate: '',
			timezone: 'Europe/Berlin',
			imageUrl: '',
			description: ''
		};
	}

	function openCreate() {
		isNew = true;
		saveError = '';
		publishWarning = '';
		uploadError = '';
		mapError = '';
		editing = blankRecord();
	}

	function openEdit(festival: FestivalRecord) {
		isNew = false;
		saveError = '';
		publishWarning = '';
		uploadError = '';
		mapError = '';
		// Legacy records predate the timezone field; default the picker to Europe/Berlin
		// (the same read-time fallback used everywhere) so the form shows a real value.
		editing = { timezone: 'Europe/Berlin', ...festival };
	}

	function closeForm() {
		editing = null;
	}

	/**
	 * Stage colors are keyed by stage name, but stages aren't a managed list — they're
	 * read off the festival's current timetable, same as the import preview does.
	 */
	async function openStageColors() {
		if (!editing) return;
		stageColorsOpen = true;
		stageColorsLoading = true;
		stageColorsError = '';
		stageNames = [];

		const result = await fetchTimetableForFestival(editing.id, editing.name);
		stageColorsLoading = false;
		if (!result.ok) {
			stageColorsError = 'Could not load this festival’s stages. Import a timetable first.';
			return;
		}
		stageNames = buildStageOrder(result.data);
	}

	function closeStageColors() {
		stageColorsOpen = false;
	}

	function setStageColor(stage: string, color: string) {
		if (!editing) return;
		editing.stageColors = { ...(editing.stageColors ?? {}), [stage]: color };
	}

	function clearStageColor(stage: string) {
		if (!editing?.stageColors) return;
		const { [stage]: _removed, ...rest } = editing.stageColors;
		editing.stageColors = rest;
	}

	/**
	 * Downscale, then presign and PUT straight to S3 — bytes never pass through this app's
	 * own API. Only updates the draft form; the new imageUrl is persisted like any other
	 * field, on the next Save.
	 */
	async function handleImageSelect(inputEvent: Event) {
		const input = inputEvent.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file || !editing) return;

		uploadingImage = true;
		uploadError = '';

		const blob = await downscaleImage(file);
		const presigned = await presignFestivalImage(editing.id, blob.type, blob.size);
		if (!presigned.ok) {
			uploadError = presigned.unauthorized
				? 'Your session has expired. Sign in again.'
				: 'Could not start the upload. Please try again.';
			uploadingImage = false;
			return;
		}

		const uploaded = await uploadToPresignedUrl(presigned.data.uploadUrl, blob);
		uploadingImage = false;
		if (!uploaded) {
			uploadError = 'Upload failed. Please try again.';
			return;
		}

		if (editing) editing.imageUrl = presigned.data.imageUrl;
	}

	/**
	 * Upload a festival map directly to S3 — raw file, no downscaling.
	 * Only updates the draft form; the new mapUrl is persisted like any other field, on Save.
	 */
	async function handleMapSelect(inputEvent: Event) {
		const input = inputEvent.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file || !editing) return;

		uploadingMap = true;
		mapError = '';

		const presigned = await presignFestivalMap(editing.id, file.type, file.size);
		if (!presigned.ok) {
			mapError = presigned.unauthorized
				? 'Your session has expired. Sign in again.'
				: 'Could not start the upload. Please try again.';
			uploadingMap = false;
			return;
		}

		const uploaded = await uploadToPresignedUrl(presigned.data.uploadUrl, file);
		uploadingMap = false;
		if (!uploaded) {
			mapError = 'Upload failed. Please try again.';
			return;
		}

		if (editing) editing.mapUrl = presigned.data.imageUrl;
	}

	function openImport(festival: FestivalRecord) {
		importTarget = festival;
		importParsed = null;
		importPreview = null;
		importErrors = [];
		importError = '';
		publishWarning = '';
	}

	function closeImport() {
		importTarget = null;
	}

	/**
	 * Parse and validate immediately on selection — the admin sees exactly what will be
	 * imported (or exactly why not) before ever touching the confirm button.
	 */
	async function handleImportFileSelect(inputEvent: Event) {
		const input = inputEvent.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file || !importTarget) return;

		importParsed = null;
		importPreview = null;
		importError = '';

		let raw: unknown;
		try {
			raw = JSON.parse(await file.text());
		} catch {
			importErrors = ['That file is not valid JSON.'];
			return;
		}

		const result = validateTimetableImport(raw);
		if (result.errors.length > 0) {
			importErrors = result.errors;
			return;
		}
		if (result.data!.festivalId !== importTarget.id) {
			importErrors = [
				`This file is for festivalId "${result.data!.festivalId}", but you're importing into "${importTarget.id}".`
			];
			return;
		}

		importErrors = [];
		importParsed = result.data!;
		importPreview = buildTimetablePreview(result.data!);
	}

	async function confirmImport() {
		if (!importTarget || !importParsed) return;

		importing = true;
		importError = '';
		const result = await importFestivalTimetable(importTarget.id, importParsed);
		importing = false;

		if (!result.ok) {
			importError = result.unauthorized
				? 'Your session has expired. Sign in again.'
				: result.status === 409
					? 'A timetable already exists for this festival — import only runs once.'
					: (result.error ?? 'Could not import the timetable. Please try again.');
			return;
		}

		importTarget = null;
		publishWarning = result.data.published !== false
			? ''
			: "Imported, but the public site hasn't updated yet — it'll catch up on the next change.";
	}

	async function saveForm() {
		if (!editing) return;
		const record: FestivalRecord = { ...editing };

		saving = true;
		saveError = '';
		const result = isNew ? await createFestival(record) : await updateFestival(record);
		saving = false;

		if (!result.ok) {
			saveError = result.unauthorized
				? 'Your session has expired. Sign in again.'
				: result.status === 409
					? 'That id is already taken.'
					: (result.error ?? 'Could not save changes. Please try again.');
			return;
		}

		festivals = isNew
			? [...festivals, result.data.festival]
			: festivals.map((f) => (f.id === record.id ? result.data.festival : f));
		editing = null;
		// Saved either way — publishing to the public site is a separate, best-effort step
		// that can fail without the save itself failing.
		publishWarning = result.data.published !== false
			? ''
			: "Saved, but the public site hasn't updated yet — it'll catch up on the next change.";
	}

	async function confirmDelete() {
		if (!deleteTarget) return;
		const festivalId = deleteTarget.id;

		saving = true;
		saveError = '';
		const result = await deleteFestival(festivalId);
		saving = false;

		if (!result.ok) {
			saveError = result.unauthorized
				? 'Your session has expired. Sign in again.'
				: (result.error ?? 'Could not delete this festival. Please try again.');
			return;
		}

		festivals = festivals.filter((f) => f.id !== festivalId);
		deleteTarget = null;
		publishWarning = result.data.published !== false
			? ''
			: "Deleted, but the public site hasn't updated yet — it'll catch up on the next change.";
	}

	onMount(async () => {
		const result = await fetchAdminFestivals();
		if (!result.ok) {
			loadError = 'Could not load the festival list. Showing the compiled defaults.';
			festivals = DEFAULT_FESTIVALS;
			loading = false;
			return;
		}
		// An empty list means nothing has been published yet — the object only exists once
		// something is saved — so the compiled defaults are what is actually live.
		festivals = result.data.festivals.length > 0 ? result.data.festivals : DEFAULT_FESTIVALS;
		loading = false;
	});

	const shownImportErrors = $derived(importErrors.slice(0, MAX_SHOWN_IMPORT_ERRORS));
	const hiddenImportErrorCount = $derived(importErrors.length - shownImportErrors.length);

	/** For a new festival, the admin sets the id; validate format and uniqueness inline. */
	const idError = $derived.by(() => {
		if (!editing || !isNew) return '';
		const id = editing.id;
		if (id.length === 0) return '';
		if (!FESTIVAL_ID_REGEX.test(id)) return '2–10 lowercase letters or digits.';
		if (festivals.some((f) => f.id === id)) return 'That id is already taken.';
		return '';
	});

	const idValid = $derived(!isNew || (FESTIVAL_ID_REGEX.test(editing?.id ?? '') && !idError));

	/** Only relevant while creating: the image upload needs a valid id to key the S3 object. */
	const canUploadImage = $derived(idValid);

	const canSave = $derived(
		!!editing &&
			idValid &&
			editing.name.trim().length > 0 &&
			editing.location.trim().length > 0 &&
			!!editing.startDate &&
			!!editing.endDate &&
			editing.startDate <= editing.endDate &&
			!!editing.timezone
	);
</script>

<div class="header-row">
	<h1>Festivals</h1>
	<button type="button" class="sh-btn sh-btn-primary" onclick={openCreate} disabled={loading}>
		New festival
	</button>
</div>

{#if loadError}
	<p class="sh-error">{loadError}</p>
{/if}

{#if publishWarning}
	<p class="sh-warning">{publishWarning}</p>
{/if}

{#if loading}
	<p class="muted">Loading…</p>
{:else}
	<table class="admin-table">
		<thead>
			<tr>
				<th>Name</th>
				<th>Location</th>
				<th>Dates</th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			{#each festivals as festival (festival.id)}
				<tr>
					<td>{festival.name}</td>
					<td class="muted">{festival.location}</td>
					<td class="muted">{festival.startDate} – {festival.endDate}</td>
					<td class="actions">
						<button type="button" class="link-btn" onclick={() => openEdit(festival)}>Edit</button>
						<button type="button" class="link-btn" onclick={() => openImport(festival)}>
							Import timetable
						</button>
						<a class="link-btn" href="/admin/festivals/{festival.id}/timetable">Edit timetable</a>
						<button type="button" class="link-btn danger" onclick={() => (deleteTarget = festival)}>
							Delete
						</button>
					</td>
				</tr>
			{:else}
				<tr>
					<td colspan="4" class="muted">No festivals.</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}

{#if editing}
	{@const form = editing}
	<Modal title={isNew ? 'New festival' : 'Edit festival'} error={saveError}>
		{#snippet children()}
			{#if isNew}
				<label class="field-label" for="festival-id">Id</label>
				<input
					id="festival-id"
					type="text"
					class="sh-input"
					bind:value={form.id}
					maxlength="10"
					placeholder="e.g. szg26"
					autocapitalize="none"
					autocomplete="off"
					spellcheck="false"
				/>
				<p class="field-hint" class:field-hint-error={!!idError}>
					{idError || '2–10 lowercase letters or digits. Frozen once created.'}
				</p>
			{/if}

			<label class="field-label" for="festival-name">Name</label>
			<input id="festival-name" type="text" class="sh-input" bind:value={form.name} maxlength="80" />

			<label class="field-label" for="festival-location">Location</label>
			<input
				id="festival-location"
				type="text"
				class="sh-input"
				bind:value={form.location}
				maxlength="80"
			/>

			<label class="field-label" for="festival-start">Start date</label>
			<input id="festival-start" type="date" class="sh-input" bind:value={form.startDate} />

			<label class="field-label" for="festival-end">End date</label>
			<input id="festival-end" type="date" class="sh-input" bind:value={form.endDate} />

			<label class="field-label" for="festival-timezone">Timezone</label>
			<select id="festival-timezone" class="sh-input" bind:value={form.timezone}>
				{#each Intl.supportedValuesOf('timeZone') as tz}
					<option value={tz}>{tz}</option>
				{/each}
			</select>

			<label class="field-label" for="festival-description">Description</label>
			<textarea
				id="festival-description"
				class="sh-input"
				rows="4"
				maxlength="1000"
				bind:value={form.description}
			></textarea>
			<p class="field-hint">Shown on the festival's detail page. Up to 1000 characters.</p>

			<label class="field-label" for="festival-image">Cover image</label>
			{#if form.imageUrl}
				<img class="image-preview" src={form.imageUrl} alt="Current cover" />
			{/if}
			{#if isNew && !canUploadImage}
				<p class="muted">Enter a valid id above to upload a cover image.</p>
			{/if}
			<input
				id="festival-image"
				type="file"
				accept="image/jpeg,image/png,image/webp"
				disabled={uploadingImage || !canUploadImage}
				onchange={handleImageSelect}
			/>
			{#if uploadingImage}
				<p class="muted">Uploading…</p>
			{/if}
			{#if uploadError}
				<p class="sh-error">{uploadError}</p>
			{/if}

			<label class="field-label" for="festival-map">Festival map</label>
			{#if form.mapUrl}
				<img class="image-preview" src={form.mapUrl} alt="Current map" />
			{/if}
			{#if isNew && !canUploadImage}
				<p class="muted">Enter a valid id above to upload a festival map.</p>
			{/if}
			<input
				id="festival-map"
				type="file"
				accept="image/jpeg,image/png,image/webp"
				disabled={uploadingMap || !canUploadImage}
				onchange={handleMapSelect}
			/>
			{#if uploadingMap}
				<p class="muted">Uploading…</p>
			{/if}
			{#if mapError}
				<p class="sh-error">{mapError}</p>
			{/if}

			{#if !isNew}
				<label class="field-label" for="festival-stage-colors">Stage colors</label>
				<button
					id="festival-stage-colors"
					type="button"
					class="sh-btn sh-btn-secondary"
					onclick={openStageColors}
				>
					Set stage colors
				</button>
				<p class="field-hint">
					Tints each stage's timetable cards and column header. Stages come from the imported
					timetable.
				</p>

				<p class="frozen-id">Id: <code>{form.id}</code> (frozen once created)</p>
			{/if}
		{/snippet}
		{#snippet actions()}
			<button type="button" class="sh-btn sh-btn-secondary" onclick={closeForm} disabled={saving}>
				Cancel
			</button>
			<button
				type="button"
				class="sh-btn sh-btn-primary"
				onclick={saveForm}
				disabled={!canSave || saving}
			>
				{saving ? 'Saving…' : 'Save'}
			</button>
		{/snippet}
	</Modal>
{/if}

{#if deleteTarget}
	<ConfirmDialog
		title="Delete festival?"
		subtitle="{deleteTarget.name} will be removed for every visitor."
		confirmLabel="Delete"
		busyLabel="Deleting…"
		busy={saving}
		error={saveError}
		onConfirm={confirmDelete}
		onCancel={() => (deleteTarget = null)}
	/>
{/if}

{#if stageColorsOpen && editing}
	{@const form = editing}
	<Modal
		title="Stage colors — {form.name}"
		subtitle="Sets a background tint for each stage's timetable cards and column header. Closing this doesn't save — hit Save on the festival form too."
		error={stageColorsError}
	>
		{#snippet children()}
			{#if stageColorsLoading}
				<p class="muted">Loading stages…</p>
			{:else if stageNames.length > 0}
				{#each stageNames as stage (stage)}
					<div class="stage-color-row">
						<span class="stage-color-name">{stage}</span>
						<input
							type="color"
							class="stage-color-input"
							value={form.stageColors?.[stage] ?? '#3a3a3a'}
							oninput={(e) => setStageColor(stage, e.currentTarget.value)}
						/>
						{#if form.stageColors?.[stage]}
							<button
								type="button"
								class="link-btn"
								onclick={() => clearStageColor(stage)}
							>
								Clear
							</button>
						{/if}
					</div>
				{/each}
			{:else if !stageColorsError}
				<p class="muted">No stages yet — import a timetable first.</p>
			{/if}
		{/snippet}
		{#snippet actions()}
			<button type="button" class="sh-btn sh-btn-primary" onclick={closeStageColors}>Done</button>
		{/snippet}
	</Modal>
{/if}

{#if importTarget}
	<Modal
		title="Import timetable — {importTarget.name}"
		subtitle="Write-once: this only works if {importTarget.name} has no timetable yet. There's no re-import — later changes happen per performance."
		error={importError}
	>
		{#snippet children()}
			<label class="field-label" for="timetable-file">Timetable file (canonical v1 JSON)</label>
			<input
				id="timetable-file"
				type="file"
				accept="application/json"
				disabled={importing}
				onchange={handleImportFileSelect}
			/>

			{#if importErrors.length > 0}
				<ul class="import-errors">
					{#each shownImportErrors as message (message)}
						<li>{message}</li>
					{/each}
					{#if hiddenImportErrorCount > 0}
						<li>…and {hiddenImportErrorCount} more.</li>
					{/if}
				</ul>
			{/if}

			{#if importPreview}
				<dl class="import-preview">
					<dt>Days</dt>
					<dd>{importPreview.dayCount}</dd>
					<dt>Performances</dt>
					<dd>{importPreview.performanceCount}</dd>
					<dt>Stages</dt>
					<dd>{importPreview.stages.join(', ')}</dd>
				</dl>
			{/if}
		{/snippet}
		{#snippet actions()}
			<button type="button" class="sh-btn sh-btn-secondary" onclick={closeImport} disabled={importing}>
				Cancel
			</button>
			<button
				type="button"
				class="sh-btn sh-btn-primary"
				onclick={confirmImport}
				disabled={!importParsed || importing}
			>
				{importing ? 'Importing…' : 'Confirm import'}
			</button>
		{/snippet}
	</Modal>
{/if}

<style>
	.header-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1.25rem;
	}

	h1 {
		margin: 0;
		font-size: 1.4rem;
	}

	.muted {
		color: #999;
	}

	.admin-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}

	.admin-table th {
		text-align: left;
		color: #999;
		font-weight: 600;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid #2e2e2e;
	}

	.admin-table td {
		padding: 0.6rem 0.75rem;
		border-bottom: 1px solid #232323;
	}

	.actions {
		text-align: right;
		white-space: nowrap;
	}

	.link-btn {
		background: none;
		border: none;
		padding: 0;
		margin-left: 1rem;
		color: #ccc;
		font-size: inherit;
		cursor: pointer;
		text-decoration: underline;
	}

	.link-btn.danger {
		color: #e74c3c;
	}

	.field-label {
		display: block;
		font-size: 0.8rem;
		color: #ccc;
		margin: 0.9rem 0 0.4rem;
	}

	.field-label:first-child {
		margin-top: 0;
	}

	.field-hint {
		margin: 0.35rem 0 0;
		font-size: 0.75rem;
		color: #888;
	}

	.field-hint-error {
		color: #e74c3c;
	}

	.frozen-id {
		margin: 1rem 0 0;
		font-size: 0.8rem;
		color: #777;
	}

	.image-preview {
		display: block;
		width: 100%;
		max-width: 240px;
		height: 90px;
		object-fit: cover;
		border-radius: 8px;
		margin-bottom: 0.5rem;
	}

	.stage-color-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.4rem 0;
		border-bottom: 1px solid #2e2e2e;
	}

	.stage-color-row:first-child {
		padding-top: 0;
	}

	.stage-color-name {
		flex: 1;
		font-size: 0.85rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.stage-color-input {
		width: 36px;
		height: 28px;
		padding: 0;
		border: 1px solid #444;
		border-radius: 4px;
		background: transparent;
		cursor: pointer;
	}

	.import-errors {
		margin: 0.75rem 0 0;
		padding-left: 1.1rem;
		max-height: 220px;
		overflow-y: auto;
		color: #e74c3c;
		font-size: 0.8rem;
		line-height: 1.6;
	}

	.import-preview {
		margin: 0.75rem 0 0;
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.25rem 0.75rem;
		font-size: 0.85rem;
	}

	.import-preview dt {
		color: #999;
	}

	.import-preview dd {
		margin: 0;
		word-break: break-word;
	}
</style>
