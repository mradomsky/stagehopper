<script lang="ts">
	/**
	 * Room browser, backed by the memberships-table scan (#38).
	 *
	 * There's no global room index in DynamoDB, so the backend returns one scanned page at a
	 * time with a cursor; this pages to the end and merges the partial per-page aggregates by
	 * room id (a busy room's rows can straddle a page boundary). The festival name isn't stored
	 * on the row — it's derived from the room id prefix, the same way the "my rooms" list does.
	 */
	import { onMount } from 'svelte';
	import ConfirmDialog from '$lib/stagehopper/components/ConfirmDialog.svelte';
	import { deleteAdminRoom, listAdminRooms } from '$lib/stagehopper/api.js';
	import { getFestivalByPrefix } from '$lib/stagehopper/festivals.svelte.js';
	import type { AdminRoomSummary, PageCursor } from '$lib/stagehopper/types.js';

	interface RoomRow extends AdminRoomSummary {
		festivalName: string;
	}

	let rooms = $state<RoomRow[]>([]);
	let loading = $state(true);
	let loadError = $state('');

	let deleteTarget = $state<RoomRow | null>(null);
	let deleting = $state(false);
	let deleteError = $state('');

	function formatDate(epochMs: number): string {
		if (!epochMs) return '—';
		return new Date(epochMs).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	async function load() {
		loading = true;
		loadError = '';

		// Merge every page by room id: each page grouped only its own rows, so counts sum and
		// timestamps max across pages.
		const byRoom = new Map<string, AdminRoomSummary>();
		let startKey: PageCursor | null = null;
		do {
			const result = await listAdminRooms(startKey);
			if (!result.ok) {
				loadError = result.unauthorized
					? 'Your session has expired. Sign in again.'
					: (result.error ?? 'Could not load rooms. Please try again.');
				loading = false;
				return;
			}
			for (const room of result.data.rooms) {
				const existing = byRoom.get(room.roomId);
				if (existing) {
					existing.participantCount += room.participantCount;
					existing.updatedAt = Math.max(existing.updatedAt, room.updatedAt);
				} else {
					byRoom.set(room.roomId, { ...room });
				}
			}
			startKey = result.data.nextKey;
		} while (startKey);

		rooms = [...byRoom.values()]
			.map((room) => ({ ...room, festivalName: getFestivalByPrefix(room.roomId)?.name ?? '—' }))
			.sort((a, b) => b.updatedAt - a.updatedAt);
		loading = false;
	}

	onMount(load);

	async function confirmDelete() {
		if (!deleteTarget) return;

		deleting = true;
		deleteError = '';
		const result = await deleteAdminRoom(deleteTarget.roomId);
		deleting = false;

		if (!result.ok) {
			deleteError = result.unauthorized
				? 'Your session has expired. Sign in again.'
				: (result.error ?? 'Could not delete the room. Please try again.');
			return;
		}
		rooms = rooms.filter((r) => r.roomId !== deleteTarget!.roomId);
		deleteTarget = null;
	}
</script>

<h1>Rooms</h1>

{#if loading}
	<p class="muted">Loading…</p>
{:else if loadError}
	<p class="sh-error">{loadError}</p>
{:else}
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
{/if}

{#if deleteTarget}
	<ConfirmDialog
		title="Delete room?"
		subtitle="{deleteTarget.roomId} and every participant's picks in it will be permanently deleted. This cannot be undone."
		confirmLabel="Delete room"
		busyLabel="Deleting…"
		busy={deleting}
		error={deleteError}
		confirmText={deleteTarget.roomId}
		onConfirm={confirmDelete}
		onCancel={() => {
			deleteTarget = null;
			deleteError = '';
		}}
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
