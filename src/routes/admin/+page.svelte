<script lang="ts">
	import { FIXTURE_FESTIVALS, FIXTURE_ROOMS, FIXTURE_USERS } from '$lib/stagehopper/admin/fixtures.js';

	const stats = [
		{ label: 'Festivals', value: FIXTURE_FESTIVALS.length, href: '/admin/festivals' },
		{ label: 'Rooms', value: FIXTURE_ROOMS.length, href: '/admin/rooms' },
		{ label: 'Users', value: FIXTURE_USERS.length, href: '/admin/users' }
	];
</script>

<h1>Overview</h1>

<div class="stat-grid">
	{#each stats as stat (stat.label)}
		<a class="stat-card" href={stat.href}>
			<span class="stat-value">{stat.value}</span>
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
