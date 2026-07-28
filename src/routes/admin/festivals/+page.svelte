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
	import { presignFestivalImage, saveFestivals, uploadToPresignedUrl } from '$lib/stagehopper/api.js';
	import { downscaleImage } from '$lib/stagehopper/admin/image-upload.js';
	import { DEFAULT_FESTIVALS, FESTIVAL_DATA_PATH } from '$lib/stagehopper/festivals.svelte.js';
	import { loadGoogleAuth } from '$lib/stagehopper/storage.js';
	import type { FestivalRecord } from '$lib/stagehopper/types.js';

	const MIN_ID_LENGTH = 2;
	const MAX_ID_LENGTH = 10;

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

	function festivalIdFromName(name: string, taken: ReadonlySet<string>): string {
		const alnum = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, MAX_ID_LENGTH);
		const base = alnum.length >= MIN_ID_LENGTH ? alnum : `fest${Date.now().toString(36)}`.slice(0, MAX_ID_LENGTH);

		if (!taken.has(base)) return base;
		for (let suffix = 2; suffix < 100; suffix++) {
			const candidate = `${base.slice(0, MAX_ID_LENGTH - String(suffix).length)}${suffix}`;
			if (!taken.has(candidate)) return candidate;
		}
		return base;
	}

	function blankRecord(): FestivalRecord {
		return {
			id: '',
			name: '',
			location: '',
			startDate: '',
			endDate: '',
			accent: 'linear-gradient(135deg, #4facfe, #6c5ce7)',
			emoji: '🎪',
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

		const auth = loadGoogleAuth();
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

	async function persist(next: FestivalRecord[]): Promise<boolean> {
		const auth = loadGoogleAuth();
		if (!auth) {
			saveError = 'Your session has expired. Sign in again.';
			return false;
		}

		saving = true;
		saveError = '';
		const result = await saveFestivals(auth.idToken, next);
		saving = false;

		if (!result.ok) {
			saveError = 'Could not save changes. Please try again.';
			return false;
		}
		festivals = result.data.festivals;
		return true;
	}

	async function saveForm() {
		if (!editing) return;
		const id = isNew
			? festivalIdFromName(
					editing.name,
					new Set(festivals.map((f) => f.id))
				)
			: editing.id;
		const record: FestivalRecord = { ...editing, id };

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
			const response = await fetch(FESTIVAL_DATA_PATH);
			festivals = response.ok ? await response.json() : DEFAULT_FESTIVALS;
		} catch {
			loadError = 'Could not load the festival list. Showing the compiled defaults.';
			festivals = DEFAULT_FESTIVALS;
		} finally {
			loading = false;
		}
	});

	const canSave = $derived(
		!!editing &&
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
					<td>{festival.emoji} {festival.name}</td>
					<td class="muted">{festival.location}</td>
					<td class="muted">{festival.startDate} – {festival.endDate}</td>
					<td class="actions">
						<button type="button" class="link-btn" onclick={() => openEdit(festival)}>Edit</button>
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

			<label class="field-label" for="festival-emoji">Emoji</label>
			<input id="festival-emoji" type="text" class="sh-input" bind:value={form.emoji} maxlength="4" />

			<label class="field-label" for="festival-accent">Card accent (CSS background)</label>
			<input id="festival-accent" type="text" class="sh-input" bind:value={form.accent} />

			<label class="field-label" for="festival-image">Cover image</label>
			{#if isNew}
				<p class="muted">Save the festival first to add a cover image.</p>
			{:else}
				{#if form.imageUrl}
					<img class="image-preview" src={form.imageUrl} alt="Current cover" />
				{/if}
				<input
					id="festival-image"
					type="file"
					accept="image/jpeg,image/png,image/webp"
					disabled={uploadingImage}
					onchange={handleImageSelect}
				/>
				{#if uploadingImage}
					<p class="muted">Uploading…</p>
				{/if}
				{#if uploadError}
					<p class="sh-error">{uploadError}</p>
				{/if}
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
</style>
