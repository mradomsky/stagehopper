<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	import '../app.css';
	import { loadFestivals } from '$lib/stagehopper/festivals.svelte.js';

	const { children }: { children: Snippet } = $props();

	/** Injected at build time by vite.config.ts; `dev` outside a git checkout. */
	const commit = import.meta.env.VITE_COMMIT ?? 'dev';

	// The room shows the commit inside its own ⋮ menu, where the fixed footer would
	// otherwise overlap the mobile bottom bar — so suppress the global footer there.
	const showFooter = $derived(!page.url.pathname.startsWith('/room/'));

	// Every route renders the compiled festival defaults first (prerendered, instant),
	// then swaps in the live list once this resolves — a stale-until-fetched flash beats
	// blocking the whole app shell on a plain static-asset read.
	onMount(() => {
		void loadFestivals();
	});
</script>

{@render children()}

{#if showFooter}
	<footer>
		<a href="https://github.com/mradomsky/stagehopper/commit/{commit}" target="_blank" rel="noopener">
			{commit}
		</a>
	</footer>
{/if}

<style>
	footer {
		position: fixed;
		bottom: 0.5rem;
		right: 0.75rem;
		font-size: 0.7rem;
		color: #555;
		pointer-events: auto;
	}

	footer a {
		color: inherit;
		text-decoration: none;
	}

	footer a:hover {
		color: #888;
	}
</style>
