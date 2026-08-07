<script lang="ts">
	/**
	 * Admin overview: one stat card per section. Festivals is a synchronous count of the
	 * loaded list; rooms and users are counted by paging their scan endpoints and tallying
	 * distinct ids (the same merge the browse pages do, reduced to a count). '—' shows until
	 * each finishes, or on failure — the overview is a signpost, not a place to block on.
	 */
	import { onMount } from 'svelte';
	import { listAdminRooms, listAdminUsers } from '$lib/stagehopper/api.js';
	import { FESTIVALS } from '$lib/stagehopper/festivals.svelte.js';
	import { loadGoogleAuth } from '$lib/stagehopper/storage.js';
	import type { PageCursor } from '$lib/stagehopper/types.js';

	let roomCount = $state<number | null>(null);
	let userCount = $state<number | null>(null);

	const stats = $derived([
		{ label: 'Festivals', value: FESTIVALS.length, href: '/admin/festivals' },
		{ label: 'Rooms', value: roomCount, href: '/admin/rooms' },
		{ label: 'Users', value: userCount, href: '/admin/users' }
	]);

	/** Page an admin list endpoint to the end, collecting the distinct ids into `ids`. */
	async function countDistinct(
		token: string,
		fetchPage: (
			t: string,
			startKey?: PageCursor | null
		) => Promise<
			| { ok: true; data: { nextKey: PageCursor | null; [k: string]: unknown } }
			| { ok: false }
		>,
		idsOf: (data: { [k: string]: unknown }) => string[]
	): Promise<number | null> {
		const ids = new Set<string>();
		let startKey: PageCursor | null = null;
		do {
			const result = await fetchPage(token, startKey);
			if (!result.ok) return null;
			for (const id of idsOf(result.data)) ids.add(id);
			startKey = result.data.nextKey;
		} while (startKey);
		return ids.size;
	}

	onMount(async () => {
		const auth = loadGoogleAuth();
		if (!auth) return;
		roomCount = await countDistinct(auth.idToken, listAdminRooms, (d) =>
			(d.rooms as { roomId: string }[]).map((r) => r.roomId)
		);
		userCount = await countDistinct(auth.idToken, listAdminUsers, (d) =>
			(d.users as { userId: string }[]).map((u) => u.userId)
		);
	});
</script>

<h1>Overview</h1>

<div class="stat-grid">
	{#each stats as stat (stat.label)}
		<a class="stat-card" href={stat.href}>
			<span class="stat-value">{stat.value ?? '—'}</span>
			<span class="stat-label">{stat.label}</span>
		</a>
	{/each}
</div>

<style>
	h1 {
		margin: 0 0 1.5rem;
		font-size: 1.4rem;
	}

	.stat-grid {
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.stat-card {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 140px;
		padding: 1rem 1.25rem;
		border: 1px solid #2e2e2e;
		border-radius: 8px;
		background: #1e1e1e;
		color: inherit;
		text-decoration: none;
	}

	.stat-card:hover {
		border-color: #555;
	}

	.stat-value {
		font-size: 1.75rem;
		font-weight: 700;
	}

	.stat-label {
		font-size: 0.8rem;
		color: #999;
	}
</style>
