<!-- PROTOTYPE — throwaway. Floating variant switcher; dev builds only. -->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	interface Props {
		variants: Array<{ key: string; name: string }>;
		current: string;
	}
	const { variants, current }: Props = $props();

	const idx = $derived(Math.max(0, variants.findIndex((v) => v.key === current)));

	function go(delta: number) {
		const next = variants[(idx + delta + variants.length) % variants.length]?.key ?? current;
		const url = new URL(page.url);
		url.searchParams.set('variant', next);
		void goto(url, { replaceState: true, noScroll: true, keepFocus: true });
	}

	function onKey(event: KeyboardEvent) {
		const t = event.target as HTMLElement | null;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
		if (event.key === 'ArrowLeft') go(-1);
		if (event.key === 'ArrowRight') go(1);
	}
</script>

<svelte:window onkeydown={onKey} />

{#if import.meta.env.DEV}
	<div class="switcher">
		<button onclick={() => go(-1)} aria-label="Previous variant">←</button>
		<span>{current} ({variants[idx]?.name ?? ''})</span>
		<button onclick={() => go(1)} aria-label="Next variant">→</button>
	</div>
{/if}

<style>
	.switcher {
		position: fixed;
		left: 50%;
		bottom: 60px;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.3rem 0.6rem;
		background: #ffd700;
		color: #111;
		border-radius: 999px;
		font: 600 0.75rem/1 monospace;
		box-shadow: 0 2px 10px rgba(0, 0, 0, 0.6);
		z-index: 1000;
	}
	.switcher button {
		background: #111;
		color: #ffd700;
		border: 0;
		border-radius: 999px;
		width: 24px;
		height: 24px;
		cursor: pointer;
	}
	@media (max-width: 767px) {
		.switcher {
			bottom: 64px;
		}
	}
</style>
