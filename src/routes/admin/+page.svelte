<script lang="ts">
	/**
	 * Admin console shell.
	 *
	 * The console itself is still to come; what is real here is the gate. The bundle is
	 * static, so this check only decides what to draw — every admin API route verifies the
	 * caller for itself and this page cannot grant anything it renders.
	 */
	import { onMount } from 'svelte';
	import { checkAdmin } from '$lib/stagehopper/api.js';
	import { loadGoogleAuth } from '$lib/stagehopper/storage.js';

	/** Undecided until the server answers, so neither outcome flashes on screen first. */
	let status = $state<'checking' | 'granted' | 'denied'>('checking');

	onMount(async () => {
		const auth = loadGoogleAuth();
		if (!auth) {
			status = 'denied';
			return;
		}
		status = (await checkAdmin(auth.idToken)) ? 'granted' : 'denied';
	});
</script>

<svelte:head>
	<title>Admin · StageHopper</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="admin">
	{#if status === 'checking'}
		<p class="muted">Checking your access…</p>
	{:else if status === 'denied'}
		<h1>Not available</h1>
		<p class="muted">This account cannot use the admin console.</p>
		<a class="sh-btn sh-btn-secondary" href="/">Back to StageHopper</a>
	{:else}
		<h1>Admin</h1>
		<p class="muted">Festival editing, image upload and timetable import land here next.</p>
		<a class="sh-btn sh-btn-secondary" href="/">Back to StageHopper</a>
	{/if}
</main>

<style>
	.admin {
		max-width: 60rem;
		margin: 0 auto;
		padding: 3rem 1.25rem;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 1rem;
	}

	h1 {
		margin: 0;
		font-size: 1.75rem;
	}

	.muted {
		margin: 0;
		color: #888;
	}
</style>
