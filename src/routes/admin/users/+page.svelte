<script lang="ts">
	/**
	 * User browser, backed by a paged scan of the users table (#38).
	 *
	 * Pages are merged by user id. Email is stored on the user's row from #38 onward; a user
	 * whose rows all predate that shows a blank email until their next save.
	 */
	import { onMount } from 'svelte';
	import ConfirmDialog from '$lib/stagehopper/components/ConfirmDialog.svelte';
	import {
		banAdminUser,
		deleteAdminUser,
		listAdminUsers,
		sendTestNotification,
		unbanAdminUser
	} from '$lib/stagehopper/api.js';
	import type { AdminUserSummary, PageCursor } from '$lib/stagehopper/types.js';

	let users = $state<AdminUserSummary[]>([]);
	let loading = $state(true);
	let loadError = $state('');

	let deleteTarget = $state<AdminUserSummary | null>(null);
	let deleting = $state(false);
	let deleteError = $state('');

	let banTarget = $state<AdminUserSummary | null>(null);
	let banning = $state(false);
	let banError = $state('');
	/** userId whose unban is in flight, and the last unban failure per user. */
	let unbanningId = $state<string | null>(null);
	let unbanError = $state<Record<string, string>>({});

	/** userId currently being tested — drives the per-row "Sending…" state. */
	let testingId = $state<string | null>(null);
	/** Per-user outcome of the last test send, shown inline next to the button. */
	let testResult = $state<Record<string, { ok: boolean; message: string }>>({});

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

		// Merge every page by user id: counts sum, name/email/lastActive follow the freshest row.
		const byUser = new Map<string, AdminUserSummary>();
		let startKey: PageCursor | null = null;
		do {
			const result = await listAdminUsers(startKey);
			if (!result.ok) {
				loadError = result.unauthorized
					? 'Your session has expired. Sign in again.'
					: (result.error ?? 'Could not load users. Please try again.');
				loading = false;
				return;
			}
			for (const user of result.data.users) {
				const existing = byUser.get(user.userId);
				if (existing) {
					if (user.lastActive >= existing.lastActive) {
						existing.lastActive = user.lastActive;
						if (user.name) existing.name = user.name;
						if (user.email) existing.email = user.email;
					}
					existing.banned = existing.banned || user.banned;
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

	async function testNotification(user: AdminUserSummary) {
		testingId = user.userId;
		// Clear any prior outcome for this row so the spinner isn't sitting next to a stale result.
		const { [user.userId]: _cleared, ...rest } = testResult;
		testResult = rest;

		const result = await sendTestNotification(user.userId);
		testingId = null;

		testResult = {
			...testResult,
			[user.userId]: result.ok
				? { ok: true, message: `Sent to ${result.data.sent}/${result.data.total} device${result.data.total === 1 ? '' : 's'}` }
				: { ok: false, message: result.unauthorized ? 'Session expired.' : (result.error ?? 'Could not send.') }
		};
	}

	/** Row state comes from the response, never from the click: HTML or an error leaves it alone. */
	function setBanned(userId: string, banned: boolean) {
		users = users.map((u) => (u.userId === userId ? { ...u, banned } : u));
	}

	async function confirmBan() {
		if (!banTarget) return;

		banning = true;
		banError = '';
		const result = await banAdminUser(banTarget.userId);
		banning = false;

		if (!result.ok) {
			banError = result.unauthorized
				? 'Your session has expired. Sign in again.'
				: (result.error ?? 'Could not ban the user. Please try again.');
			return;
		}
		setBanned(banTarget.userId, result.data.banned);
		banTarget = null;
	}

	async function unban(user: AdminUserSummary) {
		unbanningId = user.userId;
		const { [user.userId]: _cleared, ...rest } = unbanError;
		unbanError = rest;

		const result = await unbanAdminUser(user.userId);
		unbanningId = null;

		if (!result.ok) {
			unbanError = {
				...unbanError,
				[user.userId]: result.unauthorized
					? 'Session expired.'
					: (result.error ?? 'Could not unban the user.')
			};
			return;
		}
		setBanned(user.userId, result.data.banned);
	}

	async function confirmDelete() {
		if (!deleteTarget) return;

		deleting = true;
		deleteError = '';
		const result = await deleteAdminUser(deleteTarget.userId);
		deleting = false;

		if (!result.ok) {
			deleteError = result.unauthorized
				? 'Your session has expired. Sign in again.'
				: (result.error ?? 'Could not delete the user. Please try again.');
			return;
		}
		// A Banned user keeps a tombstone server-side so deleting cannot lift the ban: keep the row.
		if (!deleteTarget.banned) users = users.filter((u) => u.userId !== deleteTarget!.userId);
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
				<th>Last active</th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			{#each users as user (user.userId)}
				{@const tr = testResult[user.userId]}
				<tr>
					<td>
						{user.name || user.userId}
						{#if user.banned}<span class="badge-banned">Banned</span>{/if}
					</td>
					<td class="muted">{user.email || '—'}</td>
					<td class="muted">{formatDate(user.lastActive)}</td>
					<td class="actions">
						{#if tr}
							<span class="test-result" class:ok={tr.ok} class:fail={!tr.ok}>
								{tr.message}
							</span>
						{/if}
						<button
							type="button"
							class="link-btn"
							disabled={testingId === user.userId}
							onclick={() => testNotification(user)}
						>
							{testingId === user.userId ? 'Sending…' : 'Send test'}
						</button>
						{#if unbanError[user.userId]}
							<span class="test-result fail">{unbanError[user.userId]}</span>
						{/if}
						{#if user.banned}
							<button
								type="button"
								class="link-btn"
								disabled={unbanningId === user.userId}
								onclick={() => unban(user)}
							>
								{unbanningId === user.userId ? 'Unbanning…' : 'Unban'}
							</button>
						{:else}
							<button type="button" class="link-btn danger" onclick={() => (banTarget = user)}>
								Ban
							</button>
						{/if}
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

{#if banTarget}
	<ConfirmDialog
		title="Ban user?"
		subtitle="{banTarget.name || banTarget.userId} will no longer be able to save picks or post messages. They can still read. You can unban them at any time."
		confirmLabel="Ban user"
		busyLabel="Banning…"
		busy={banning}
		error={banError}
		onConfirm={confirmBan}
		onCancel={() => {
			banTarget = null;
			banError = '';
		}}
	/>
{/if}

{#if deleteTarget}
	<ConfirmDialog
		title="Delete user?"
		subtitle="{deleteTarget.name || deleteTarget.userId} will be removed along with all their Picks and Messages. This cannot be undone.{deleteTarget.banned ? " The ban stays in place." : ""}"
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
		margin-left: 0.9rem;
		color: #ccc;
		font-size: inherit;
		cursor: pointer;
		text-decoration: underline;
	}

	.link-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.link-btn.danger {
		color: #e74c3c;
	}

	.badge-banned {
		margin-left: 0.5rem;
		padding: 0.1rem 0.45rem;
		border: 1px solid #e74c3c;
		border-radius: 6px;
		color: #e74c3c;
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.test-result {
		font-size: 0.8rem;
		margin-right: 0.25rem;
	}

	.test-result.ok {
		color: #27ae60;
	}

	.test-result.fail {
		color: #e67e22;
	}
</style>
