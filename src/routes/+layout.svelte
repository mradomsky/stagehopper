<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	import '../app.css';
	import { ensureFestivalsLoaded } from '$lib/stagehopper/festivals.svelte.js';
	import InstallPromo from '$lib/stagehopper/components/InstallPromo.svelte';
	import { initInstallPrompt, installPromoOpen } from '$lib/stagehopper/install.js';

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
		// beforeinstallprompt can fire before any page mounts, so start listening app-wide here.
		initInstallPrompt();
		// The worker is what caches /data/* and what receives pushes, so it has to exist on
		// every route — it used to be registered from the room page alone, which left the
		// landing and festival pages uncached and meant a visitor who had never opened a room
		// got no worker at all (and with it, no native Android install prompt).
		//
		// updateViaCache: 'none' forces the browser to revalidate sw.js against the network
		// instead of trusting its HTTP cache. Safari (iOS especially) honours the script's own
		// Cache-Control here, so a long-lived `immutable` copy could otherwise pin a stale
		// worker — and a worker predating the push handler accepts subscriptions while
		// silently dropping every push it receives.
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
		}
	});
</script>

{@render children()}

{#if $installPromoOpen}
	<InstallPromo />
{/if}

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
