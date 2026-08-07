<script lang="ts">
	/**
	 * User browser, backed by the memberships-table scan (#38).
	 *
	 * Same paged-scan-and-merge contract as the rooms page, grouped by user id instead. Email
	 * is stored on the membership row from #38 onward; a user whose rows all predate that shows
	 * a blank email until their next save.
	 */
	import { onMount } from 'svelte';
	import ConfirmDialog from '$lib/stagehopper/components/ConfirmDialog.svelte';
	import { deleteAdminUser, listAdminUsers } from '$lib/stagehopper/api.js';
	import { loadGoogleAuth } from '$lib/stagehopper/storage.js';
	import type { AdminUserSummary, PageCursor } from '$lib/stagehopper/types.js';

	let users = $state<AdminUserSummary[]>([]);
	let loading = $state(true);
	let loadError = $state('');

	let deleteTarget = $state<AdminUserSummary | null>(null);
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
		const auth = loadGoogleAuth();
		if (!auth) {
			loadError = 'Your session has expired. Sign in again.';
			loading = false;
			return;
		}

		loading = true;
		loadError = '';

		// Merge every page by user id: counts sum, name/email/lastActive follow the freshest row.
		const byUser = new Map<string, AdminUserSummary>();
		let startKey: PageCursor | null = null;
		do {
			const result = await listAdminUsers(auth.idToken, startKey);
			if (!result.ok) {
				loadError = result.error ?? 'Could not load users. Please try again.';
				loading = false;
				return;
			}
			for (const user of result.data.users) {
				const existing = byUser.get(user.userId);
				if (existing) {
					existing.roomCount += user.roomCount;
					if (user.lastActive >= existing.lastActive) {
						existing.lastActive = user.lastActive;
						if (user.name) existing.name = user.name;
						if (user.email) existing.email = user.email;
					}
				} else {
					byUser.set(user.userId, { ...user });
				}
			}
			startKey = result.data.nextKey;
		} while (startKey);

		users = [...byUser.values()].sort((a, b) => b.lastActive - a.lastActive);
		loading = false;
	}

	onMount(load);

	async function confirmDelete() {
		if (!deleteTarget) return;
		const auth = loadGoogleAuth();
		if (!auth) {
			deleteError = 'Your session has expired. Sign in again.';
			return;
		}

		deleting = true;
		deleteError = '';
		const result = await deleteAdminUser(auth.idToken, deleteTarget.userId);
		deleting = false;

		if (!result.ok) {
			deleteError = result.error ?? 'Could not delete the user. Please try again.';
			return;
		}
		users = users.filter((u) => u.userId !== deleteTarget!.userId);
		deleteTarget = null;
	}
</script>

<h1>Users</h1>

{#if loading}
	<p class="muted">Loading…</p>
{:else if loadError}
	<p class="sh-error">{loadError}</p>
{:else}
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
					<td>{user.name || '—'}</td>
					<td class="muted">{user.email || '—'}</td>
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
{/if}

{#if deleteTarget}
	<ConfirmDialog
		title="Delete user?"
		subtitle="{deleteTarget.name || deleteTarget.userId} will be removed from every room they've joined, along with all their picks. This cannot be undone."
		confirmLabel="Delete user"
		busyLabel="Deleting…"
		busy={deleting}
		error={deleteError}
		confirmText={deleteTarget.userId}
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
