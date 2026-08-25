<script lang="ts">
	/**
	 * Per-performance timetable editing: the same grid the room page renders, but tapping
	 * a card opens an edit form instead of the read-only artist details.
	 *
	 * Every edit is a small PATCH, written as a single DynamoDB item — concurrent edits to
	 * different performances are fully independent; two edits to the same performance are
	 * last-write-wins, with no conflict response (a smaller blast radius than the old
	 * whole-file S3 write this replaced, so no locking was reintroduced for it).
	 */
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import Modal from '$lib/stagehopper/components/Modal.svelte';
	import ConfirmDialog from '$lib/stagehopper/components/ConfirmDialog.svelte';
	import TimetableGrid from '$lib/stagehopper/components/TimetableGrid.svelte';
	import {
		patchFestivalTimetable,
		updateFestivalStageOrder,
		type TimetablePerformancePatch
	} from '$lib/stagehopper/api.js';
	import { getFestivalById } from '$lib/stagehopper/festivals.svelte.js';
	import {
		fetchTimetableForFestival,
		groupPerformancesByStage,
		resolveStageOrder,
		toDisplayTimetable
	} from '$lib/stagehopper/timetable.js';
	import { buildHourMarkers, computeDayGridRange, PX_PER_MIN } from '$lib/stagehopper/time.js';
	import type { Performance, Timetable } from '$lib/stagehopper/types.js';

	const festivalId = $derived(page.params.id ?? '');
	const festival = $derived(getFestivalById(festivalId));

	let timetable = $state<Timetable>({ festival: '', days: [] });
	let loading = $state(true);
	let loadError = $state('');
	let currentDayIdx = $state(0);

	let editing = $state<{ performance: Performance; isNew: boolean } | null>(null);
	let editDate = $state('');
	let deleteTarget = $state<Performance | null>(null);
	let saving = $state(false);
	let formError = $state('');
	/** Set after a save/delete that landed but whose publish to the public site failed. */
	let publishWarning = $state('');

	/**
	 * The order from a drag this session, once there's been one — takes precedence over
	 * `festival.stageOrder` so a reorder shows immediately without waiting on the public
	 * manifest (which this page doesn't re-fetch after a save).
	 */
	let stageOrderOverride = $state<string[] | null>(null);
	let savingStageOrder = $state(false);
	let stageOrderError = $state('');

	const stageOrder = $derived(
		resolveStageOrder(timetable, stageOrderOverride ?? festival?.stageOrder)
	);
	const currentDay = $derived(timetable.days[currentDayIdx]);
	const stagesForDay = $derived(groupPerformancesByStage(currentDay, stageOrder));
	const gridRange = $derived(computeDayGridRange(currentDay));
	const gridStartMin = $derived(gridRange.start);
	const gridEndMin = $derived(gridRange.end);
	const hourMarkers = $derived(buildHourMarkers(gridStartMin, gridEndMin));
	const gridHeightPx = $derived((gridEndMin - gridStartMin) * PX_PER_MIN);

	async function load() {
		if (!festivalId) return;
		loading = true;
		loadError = '';
		const result = await fetchTimetableForFestival(festivalId, festival?.name ?? festivalId);
		loading = false;
		if (!result.ok) {
			loadError = 'Could not load the timetable.';
			return;
		}
		timetable = result.data;
		if (currentDayIdx >= timetable.days.length) currentDayIdx = 0;
	}

	onMount(load);

	function openEdit(performance: Performance) {
		editing = { performance: { ...performance }, isNew: false };
		editDate = currentDay?.date ?? '';
		formError = '';
		publishWarning = '';
	}

	/** Random hex, matching the room id pattern (`generateRoomId` in rooms.ts). */
	function generatePerformanceId(): string {
		return Math.floor(Math.random() * 16777216)
			.toString(16)
			.padStart(6, '0');
	}

	function openAdd() {
		editing = {
			performance: { id: generatePerformanceId(), artist: '', stage: '', startTime: '', endTime: '' },
			isNew: true
		};
		editDate = currentDay?.date ?? timetable.days[0]?.date ?? '';
		formError = '';
		publishWarning = '';
	}

	function closeEdit() {
		editing = null;
	}

	function buildPatch(performance: Performance, isNew: boolean): TimetablePerformancePatch {
		return {
			...(isNew && { date: editDate }),
			artist: performance.artist,
			stage: performance.stage,
			startTime: performance.startTime,
			endTime: performance.endTime,
			// Always sent, even empty: a blank value means "clear this field", and an
			// omitted key would leave whatever was previously stored untouched instead.
			artistImage: performance.artistImage ?? '',
			instagram: performance.instagram ?? '',
			spotify: performance.spotify ?? '',
			youtube: performance.youtube ?? '',
			soundcloud: performance.soundcloud ?? ''
		};
	}

	async function applyPatch(performanceId: string, patch: TimetablePerformancePatch | null): Promise<boolean> {
		saving = true;
		formError = '';
		const result = await patchFestivalTimetable(festivalId, performanceId, patch);
		saving = false;

		if (!result.ok) {
			formError = result.unauthorized
				? 'Your session has expired. Sign in again.'
				: (result.error ?? 'Could not save. Please try again.');
			return false;
		}

		timetable = toDisplayTimetable(festival?.name ?? festivalId, result.data.timetable.days);
		// Saved either way — publishing to the public site is a separate, best-effort step
		// that can fail without the save itself failing.
		publishWarning = result.data.published !== false
			? ''
			: "Saved, but the public site hasn't updated yet — it'll catch up on the next change.";
		return true;
	}

	/** Fires on every header drop: optimistic reorder, then save in the background. */
	async function reorderStages(newOrder: string[]) {
		stageOrderOverride = newOrder;
		savingStageOrder = true;
		stageOrderError = '';

		const result = await updateFestivalStageOrder(festivalId, newOrder);
		savingStageOrder = false;

		if (!result.ok) {
			stageOrderError = result.unauthorized
				? 'Your session has expired. Sign in again.'
				: (result.error ?? 'Could not save the stage order. Please try again.');
			return;
		}
		publishWarning = result.data.published !== false
			? ''
			: "Saved, but the public site hasn't updated yet — it'll catch up on the next change.";
	}

	async function saveEdit() {
		if (!editing) return;
		const ok = await applyPatch(editing.performance.id, buildPatch(editing.performance, editing.isNew));
		if (ok) editing = null;
	}

	async function confirmDelete() {
		if (!deleteTarget) return;
		const ok = await applyPatch(deleteTarget.id, null);
		if (ok) deleteTarget = null;
	}

	const canSave = $derived(
		!!editing &&
			editing.performance.artist.trim().length > 0 &&
			editing.performance.stage.trim().length > 0 &&
			!!editing.performance.startTime &&
			!!editing.performance.endTime &&
			(!editing.isNew || !!editDate)
	);
</script>

<div class="header-row">
	<h1>Timetable — {festival?.name ?? festivalId}</h1>
	<a class="sh-btn sh-btn-secondary" href="/admin/festivals">Back to festivals</a>
</div>

{#if publishWarning}
	<p class="sh-warning">{publishWarning}</p>
{/if}

{#if loading}
	<p class="muted">Loading…</p>
{:else if loadError}
	<p class="sh-error">{loadError}</p>
{:else}
	<div class="day-tabs">
		{#each timetable.days as day, index (day.date)}
			<button
				type="button"
				class="day-tab"
				class:day-tab-active={currentDayIdx === index}
				onclick={() => (currentDayIdx = index)}
			>
				{day.label}
			</button>
		{/each}
		<button type="button" class="sh-btn sh-btn-primary add-btn" onclick={openAdd}>
			Add performance
		</button>
	</div>

	<p class="drag-hint">
		Drag a column header to reorder stages.
		{#if savingStageOrder}
			Saving…
		{:else if stageOrderError}
			<span class="sh-error">{stageOrderError}</span>
		{/if}
	</p>

	<div class="grid-wrap">
		<TimetableGrid
			stages={stagesForDay}
			{hourMarkers}
			{gridStartMin}
			{gridHeightPx}
			nowTopPx={0}
			nowVisible={false}
			color="#e74c3c"
			stageColors={festival?.stageColors}
			stateOf={() => 0}
			marksOf={() => []}
			showMark={false}
			onOpenDetails={(performance) => openEdit(performance)}
			onToggleMark={() => {}}
			onReorderStages={reorderStages}
			onSwipeDay={(delta) => {
				const next = currentDayIdx + delta;
				if (next >= 0 && next < timetable.days.length) currentDayIdx = next;
			}}
		/>
	</div>
{/if}

{#if editing}
	{@const perf = editing.performance}
	{@const isNew = editing.isNew}
	<Modal title={isNew ? 'Add performance' : 'Edit performance'} error={formError}>
		{#snippet children()}
			{#if isNew}
				<label class="field-label" for="perf-date">Day</label>
				<select id="perf-date" class="sh-input" bind:value={editDate}>
					{#each timetable.days as day (day.date)}
						<option value={day.date}>{day.label}</option>
					{/each}
				</select>
			{/if}

			<label class="field-label" for="perf-artist">Artist</label>
			<input id="perf-artist" type="text" class="sh-input" bind:value={perf.artist} maxlength="120" />

			<label class="field-label" for="perf-stage">Stage</label>
			<input id="perf-stage" type="text" class="sh-input" bind:value={perf.stage} maxlength="80" />

			<label class="field-label" for="perf-start">Start time</label>
			<input id="perf-start" type="time" class="sh-input" bind:value={perf.startTime} />

			<label class="field-label" for="perf-end">End time</label>
			<input id="perf-end" type="time" class="sh-input" bind:value={perf.endTime} />

			<label class="field-label" for="perf-image">Artist image URL</label>
			<input
				id="perf-image"
				type="text"
				class="sh-input"
				value={perf.artistImage ?? ''}
				oninput={(e) => (perf.artistImage = e.currentTarget.value)}
			/>

			<label class="field-label" for="perf-instagram">Instagram</label>
			<input
				id="perf-instagram"
				type="text"
				class="sh-input"
				value={perf.instagram ?? ''}
				oninput={(e) => (perf.instagram = e.currentTarget.value)}
			/>

			<label class="field-label" for="perf-spotify">Spotify</label>
			<input
				id="perf-spotify"
				type="text"
				class="sh-input"
				value={perf.spotify ?? ''}
				oninput={(e) => (perf.spotify = e.currentTarget.value)}
			/>

			<label class="field-label" for="perf-youtube">YouTube</label>
			<input
				id="perf-youtube"
				type="text"
				class="sh-input"
				value={perf.youtube ?? ''}
				oninput={(e) => (perf.youtube = e.currentTarget.value)}
			/>

			<label class="field-label" for="perf-soundcloud">SoundCloud</label>
			<input
				id="perf-soundcloud"
				type="text"
				class="sh-input"
				value={perf.soundcloud ?? ''}
				oninput={(e) => (perf.soundcloud = e.currentTarget.value)}
			/>
		{/snippet}
		{#snippet actions()}
			<button type="button" class="sh-btn sh-btn-secondary" onclick={closeEdit} disabled={saving}>
				Cancel
			</button>
			{#if !isNew}
				<button
					type="button"
					class="sh-btn sh-btn-secondary danger"
					onclick={() => {
						deleteTarget = perf;
						editing = null;
					}}
					disabled={saving}
				>
					Delete
				</button>
			{/if}
			<button type="button" class="sh-btn sh-btn-primary" onclick={saveEdit} disabled={!canSave || saving}>
				{saving ? 'Saving…' : 'Save'}
			</button>
		{/snippet}
	</Modal>
{/if}

{#if deleteTarget}
	<ConfirmDialog
		title="Delete performance?"
		subtitle="{deleteTarget.artist} will be removed from the timetable. Anyone who already marked it keeps a pick that no longer resolves to anything — that's expected, not cleaned up."
		confirmLabel="Delete"
		busyLabel="Deleting…"
		busy={saving}
		error={formError}
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

	.day-tabs {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-bottom: 1rem;
		flex-wrap: wrap;
	}

	.day-tab {
		background: transparent;
		border: 1px solid #444;
		border-radius: 6px;
		color: #aaa;
		padding: 0.4rem 0.8rem;
		font-size: 0.8rem;
		cursor: pointer;
	}

	.day-tab:hover {
		background: #262626;
		color: #eee;
	}

	.day-tab-active {
		background: #262626;
		border-color: #e74c3c;
		color: #fffaf0;
	}

	.add-btn {
		margin-left: auto;
	}

	.drag-hint {
		margin: 0 0 0.6rem;
		font-size: 0.78rem;
		color: #777;
	}

	.grid-wrap {
		display: flex;
		flex-direction: column;
		height: 70vh;
		border: 1px solid #2e2e2e;
		border-radius: 8px;
		overflow: hidden;
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

	.danger {
		color: #e74c3c;
		border-color: #e74c3c;
	}
</style>
