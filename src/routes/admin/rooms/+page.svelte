<script lang="ts">
	/** Room browser against the fixtures. The real Scan-backed listing lands in #38. */
	import ConfirmDialog from '$lib/stagehopper/components/ConfirmDialog.svelte';
	import { FIXTURE_ROOMS, type AdminRoom } from '$lib/stagehopper/admin/fixtures.js';

	let rooms = $state<AdminRoom[]>([...FIXTURE_ROOMS]);
	let deleteTarget = $state<AdminRoom | null>(null);

	function formatDate(epochMs: number): string {
		return new Date(epochMs).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function confirmDelete() {
		if (!deleteTarget) return;
		rooms = rooms.filter((r) => r.roomId !== deleteTarget!.roomId);
		deleteTarget = null;
	}
</script>

<h1>Rooms</h1>

<table class="admin-table">
	<thead>
		<tr>
			<th>Room id</th>
			<th>Festival</th>
			<th>Participants</th>
			<th>Last updated</th>
			<th></th>
		</tr>
	</thead>
	<tbody>
		{#each rooms as room (room.roomId)}
			<tr>
				<td><code>{room.roomId}</code></td>
				<td>{room.festivalName}</td>
				<td>{room.participantCount}</td>
				<td class="muted">{formatDate(room.updatedAt)}</td>
				<td class="actions">
					<button type="button" class="link-btn danger" onclick={() => (deleteTarget = room)}>
						Delete
					</button>
				</td>
			</tr>
		{:else}
			<tr>
				<td colspan="5" class="muted">No rooms.</td>
			</tr>
		{/each}
	</tbody>
</table>

{#if deleteTarget}
	<ConfirmDialog
		title="Delete room?"
		subtitle="{deleteTarget.roomId} and every participant's picks in it will be removed. This only affects this session's mock data."
		confirmLabel="Delete"
		onConfirm={confirmDelete}
		onCancel={() => (deleteTarget = null)}
	/>
{/if}

<style>
	h1 {
		margin: 0 0 1.25rem;
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
		color: #ccc;
		font-size: inherit;
		cursor: pointer;
		text-decoration: underline;
	}

	.link-btn.danger {
		color: #e74c3c;
	}
</style>
