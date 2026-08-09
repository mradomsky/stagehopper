<script lang="ts">
	/**
	 * Festival list plus create/edit form, against the real `data/festivals.json`.
	 *
	 * Reads go straight to the public path — the same one the landing page fetches — since
	 * a Google id token can't travel on a GET without a body. Every save PUTs the whole
	 * list; there's no per-record endpoint. The id is generated on create and frozen on
	 * every later edit, since it's baked into every room id already created under it.
	 */
	import { onMount } from 'svelte';
	import Modal from '$lib/stagehopper/components/Modal.svelte';
	import ConfirmDialog from '$lib/stagehopper/components/ConfirmDialog.svelte';
	import {
		importFestivalTimetable,
		presignFestivalImage,
		saveFestivals,
		uploadToPresignedUrl
	} from '$lib/stagehopper/api.js';
	import { downscaleImage } from '$lib/stagehopper/admin/image-upload.js';
	import { DEFAULT_FESTIVALS, FESTIVAL_DATA_PATH } from '$lib/stagehopper/festivals.svelte.js';
	import { ensureFreshGoogleAuth } from '$lib/stagehopper/auth.js';
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

	let editing = $state<FestivalRecord | null>(null);
	let isNew = $state(false);
	let deleteTarget = $state<FestivalRecord | null>(null);

	let uploadingImage = $state(false);
	let uploadError = $state('');

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
			imageUrl: ''
		};
	}

	function openCreate() {
		isNew = true;
		saveError = '';
		uploadError = '';
		editing = blankRecord();
	}

	function openEdit(festival: FestivalRecord) {
		isNew = false;
		saveError = '';
		uploadError = '';
		editing = { ...festival };
	}

	function closeForm() {
		editing = null;
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

		const auth = await ensureFreshGoogleAuth();
		if (!auth) {
			uploadError = 'Your session has expired. Sign in again.';
			return;
		}

		uploadingImage = true;
		uploadError = '';

		const blob = await downscaleImage(file);
		const presigned = await presignFestivalImage(auth.idToken, editing.id, blob.type, blob.size);
		if (!presigned.ok) {
			uploadError = 'Could not start the upload. Please try again.';
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

	function openImport(festival: FestivalRecord) {
		importTarget = festival;
		importParsed = null;
		importPreview = null;
		importErrors = [];
		importError = '';
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

		const auth = await ensureFreshGoogleAuth();
		if (!auth) {
			importError = 'Your session has expired. Sign in again.';
			return;
		}

		importing = true;
		importError = '';
		const result = await importFestivalTimetable(auth.idToken, importTarget.id, importParsed);
		importing = false;

		if (!result.ok) {
			importError =
				result.status === 409
					? 'A timetable already exists for this festival — import only runs once.'
					: (result.error ?? 'Could not import the timetable. Please try again.');
			return;
		}

		importTarget = null;
	}

	async function persist(next: FestivalRecord[]): Promise<boolean> {
		const auth = await ensureFreshGoogleAuth();
		if (!auth) {
			saveError = 'Your session has expired. Sign in again.';
			return false;
		}

		saving = true;
		saveError = '';
		const result = await saveFestivals(auth.idToken, next);
		saving = false;

		if (!result.ok) {
			saveError = result.error ?? 'Could not save changes. Please try again.';
			return false;
		}
		festivals = result.data.festivals;
		return true;
	}

	async function saveForm() {
		if (!editing) return;
		const record: FestivalRecord = { ...editing };

		const next = isNew
			? [...festivals, record]
			: festivals.map((f) => (f.id === record.id ? record : f));

		if (await persist(next)) editing = null;
	}

	async function confirmDelete() {
		if (!deleteTarget) return;
		const next = festivals.filter((f) => f.id !== deleteTarget!.id);
		if (await persist(next)) deleteTarget = null;
	}

	onMount(async () => {
		try {
			// `no-store`: this list mutates on every save, so the admin must always read the
			// live copy. Without it the browser can serve a stale cached response and a
			// just-saved festival looks like it vanished on reload.
			const response = await fetch(FESTIVAL_DATA_PATH, { cache: 'no-store' });
			festivals = response.ok ? await response.json() : DEFAULT_FESTIVALS;
		} catch {
			loadError = 'Could not load the festival list. Showing the compiled defaults.';
			festivals = DEFAULT_FESTIVALS;
		} finally {
			loading = false;
		}
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
			editing.startDate <= editing.endDate
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

			{#if !isNew}
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
