<script lang="ts">
	/**
	 * Festival list plus create/edit form, against the fixtures — no admin write route
	 * exists yet (#34). The id is generated on create and frozen on every later edit, since
	 * it is baked into every room id already created under it.
	 */
	import Modal from '$lib/stagehopper/components/Modal.svelte';
	import ConfirmDialog from '$lib/stagehopper/components/ConfirmDialog.svelte';
	import { FIXTURE_FESTIVALS, type AdminFestival } from '$lib/stagehopper/admin/fixtures.js';

	let festivals = $state<AdminFestival[]>([...FIXTURE_FESTIVALS]);

	type FormState = Omit<AdminFestival, 'prefix'>;

	let editing = $state<FormState | null>(null);
	let isNew = $state(false);
	let deleteTarget = $state<AdminFestival | null>(null);

	function slugify(name: string): string {
		return name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 20);
	}

	function openCreate() {
		isNew = true;
		editing = {
			id: '',
			name: '',
			subtitle: '',
			past: false,
			accent: 'linear-gradient(135deg, #4facfe, #6c5ce7)',
			emoji: '🎪',
			cardImageUrl: ''
		};
	}

	function openEdit(festival: AdminFestival) {
		isNew = false;
		editing = { ...festival };
	}

	function closeForm() {
		editing = null;
	}

	function saveForm() {
		if (!editing) return;
		const id = isNew ? slugify(editing.name) || `festival-${Date.now()}` : editing.id;
		const saved: AdminFestival = { ...editing, id, prefix: `${id}-` };

		festivals = isNew
			? [...festivals, saved]
			: festivals.map((f) => (f.id === saved.id ? saved : f));
		editing = null;
	}

	function confirmDelete() {
		if (!deleteTarget) return;
		festivals = festivals.filter((f) => f.id !== deleteTarget!.id);
		deleteTarget = null;
	}

	const canSave = $derived(!!editing && editing.name.trim().length > 0);
</script>

<div class="header-row">
	<h1>Festivals</h1>
	<button type="button" class="sh-btn sh-btn-primary" onclick={openCreate}>New festival</button>
</div>

<table class="admin-table">
	<thead>
		<tr>
			<th>Name</th>
			<th>Subtitle</th>
			<th>Status</th>
			<th></th>
		</tr>
	</thead>
	<tbody>
		{#each festivals as festival (festival.id)}
			<tr>
				<td>{festival.emoji} {festival.name}</td>
				<td class="muted">{festival.subtitle}</td>
				<td>{festival.past ? 'Past' : 'Upcoming'}</td>
				<td class="actions">
					<button type="button" class="link-btn" onclick={() => openEdit(festival)}>Edit</button>
					<button type="button" class="link-btn danger" onclick={() => (deleteTarget = festival)}>
						Delete
					</button>
				</td>
			</tr>
		{/each}
	</tbody>
</table>

{#if editing}
	{@const form = editing}
	<Modal title={isNew ? 'New festival' : 'Edit festival'}>
		{#snippet children()}
			<label class="field-label" for="festival-name">Name</label>
			<input id="festival-name" type="text" class="sh-input" bind:value={form.name} maxlength="80" />

			<label class="field-label" for="festival-subtitle">Subtitle</label>
			<input
				id="festival-subtitle"
				type="text"
				class="sh-input"
				bind:value={form.subtitle}
				maxlength="120"
			/>

			<label class="field-label" for="festival-emoji">Emoji</label>
			<input id="festival-emoji" type="text" class="sh-input" bind:value={form.emoji} maxlength="4" />

			<label class="field-label" for="festival-image">Card image URL</label>
			<input
				id="festival-image"
				type="text"
				class="sh-input"
				bind:value={form.cardImageUrl}
				placeholder="Uploads land in a later issue"
			/>

			<label class="field-checkbox">
				<input type="checkbox" bind:checked={form.past} />
				Past festival
			</label>

			{#if !isNew}
				<p class="frozen-id">Id: <code>{form.id}</code> (frozen once created)</p>
			{/if}
		{/snippet}
		{#snippet actions()}
			<button type="button" class="sh-btn sh-btn-secondary" onclick={closeForm}>Cancel</button>
			<button type="button" class="sh-btn sh-btn-primary" onclick={saveForm} disabled={!canSave}>
				Save
			</button>
		{/snippet}
	</Modal>
{/if}

{#if deleteTarget}
	<ConfirmDialog
		title="Delete festival?"
		subtitle="{deleteTarget.name} will be removed. This only affects this session's mock data."
		confirmLabel="Delete"
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

	.muted {
		color: #999;
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

	.field-checkbox {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 1rem;
		font-size: 0.85rem;
		color: #ccc;
	}

	.frozen-id {
		margin: 1rem 0 0;
		font-size: 0.8rem;
		color: #777;
	}
</style>
