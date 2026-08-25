<script lang="ts">
	interface Props {
		/** Filled bell (notifications on) vs. an outline bell (off) — the same on/off idiom
		 *  as the ★/☆ star, replacing the old 🔔/🔕 emoji pair (inconsistent across
		 *  platforms, and not stylable via CSS `color`). */
		filled?: boolean;
	}

	const { filled = false }: Props = $props();
</script>

{#if filled}
	<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
		<path
			d="M12 2a1 1 0 0 0-1 1v.09A6 6 0 0 0 6 9v4.586l-1.707 1.707A1 1 0 0 0 5 17h14a1 1 0 0 0 .707-1.707L18 13.586V9a6 6 0 0 0-5-5.91V3a1 1 0 0 0-1-1Zm-2.5 17a2.5 2.5 0 0 0 5 0h-5Z"
		/>
	</svg>
{:else}
	<svg
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="1.6"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		<path d="M6 9a6 6 0 0 1 12 0v4.586l1.707 1.707A1 1 0 0 1 19 17H5a1 1 0 0 1-.707-1.707L6 13.586V9Z" />
		<path d="M9.5 19a2.5 2.5 0 0 0 5 0" />
	</svg>
{/if}

<style>
	svg {
		width: 1em;
		height: 1em;
		display: inline-block;
		vertical-align: middle;
	}
</style>
