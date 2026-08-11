<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	import '../app.css';
	import { ensureFestivalsLoaded } from '$lib/stagehopper/festivals.svelte.js';

	const { children }: { children: Snippet } = $props();

	/** Injected at build time by vite.config.ts; the deployed release tag, `dev` locally. */
	const version = import.meta.env.VITE_VERSION ?? 'dev';

	// The room shows the version inside its own ⋮ menu instead of a footer.
	const showFooter = $derived(!page.url.pathname.startsWith('/room/'));

	// Every route renders the compiled festival defaults first (prerendered, instant),
	// then swaps in the live list once this resolves — a stale-until-fetched flash beats
	// blocking the whole app shell on a plain static-asset read.
	onMount(() => {
		void ensureFestivalsLoaded();
	});
</script>

{@render children()}

{#if showFooter}
	<footer>
		<a
			href="https://github.com/mradomsky/stagehopper/releases/tag/{version}"
			target="_blank"
			rel="noopener"
		>
			{version}
		</a>
	</footer>
{/if}

<style>
	footer {
		padding: 1rem 0.75rem;
		text-align: right;
		font-size: 0.7rem;
		color: #555;
	}

	footer a {
		color: inherit;
		text-decoration: none;
	}

	footer a:hover {
		color: #888;
	}
</style>
