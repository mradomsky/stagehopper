<script lang="ts">
	/** User browser against the fixtures. The real Scan-backed listing lands in #38. */
	import ConfirmDialog from '$lib/stagehopper/components/ConfirmDialog.svelte';
	import { FIXTURE_USERS, type AdminUser } from '$lib/stagehopper/admin/fixtures.js';

	let users = $state<AdminUser[]>([...FIXTURE_USERS]);
	let deleteTarget = $state<AdminUser | null>(null);

	function formatDate(epochMs: number): string {
		return new Date(epochMs).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function confirmDelete() {
		if (!deleteTarget) return;
		users = users.filter((u) => u.userId !== deleteTarget!.userId);
		deleteTarget = null;
	}
</script>

<h1>Users</h1>

<table class="admin-table">
	<thead>
		<tr>
			<th>Name</th>
			<th>Email</th>
			<th>Rooms</th>
			<th>Last active</th>
			<th></th>
		</tr>
	</thead>
	<tbody>
		{#each users as user (user.userId)}
			<tr>
				<td>{user.name}</td>
				<td class="muted">{user.email}</td>
				<td>{user.roomCount}</td>
				<td class="muted">{formatDate(user.lastActive)}</td>
				<td class="actions">
					<button type="button" class="link-btn danger" onclick={() => (deleteTarget = user)}>
						Delete
					</button>
				</td>
			</tr>
		{:else}
			<tr>
				<td colspan="5" class="muted">No users.</td>
			</tr>
		{/each}
	</tbody>
</table>

{#if deleteTarget}
	<ConfirmDialog
		title="Delete user?"
		subtitle="{deleteTarget.name} and every room they've joined will be removed. This only affects this session's mock data."
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
