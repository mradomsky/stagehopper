<script lang="ts">
	import OptionsMenu from './OptionsMenu.svelte';
	import { VIEW_MODES } from '../view-modes.js';
	import type { ViewMode } from '../types.js';

	interface MenuItem {
		label: string;
		onSelect: () => void;
	}

	interface Props {
		viewMode: ViewMode;
		/** Guests browsing a lineup have no picks, so only the menu shows. */
		showViewTabs: boolean;
		menuItems: MenuItem[];
		/** Whether a festival map is available. */
		showMap?: boolean;
		onSelectViewMode: (mode: ViewMode) => void;
		/** Open the map overlay. */
		onOpenMap?: () => void;
	}

	const { viewMode, showViewTabs, showMap, menuItems, onSelectViewMode, onOpenMap }: Props = $props();
</script>

<div class="mobile-bottom-bar">
	{#if showViewTabs}
		{#each VIEW_MODES as mode (mode.id)}
			<button
				class="bottom-btn"
				class:bottom-btn-active={viewMode === mode.id}
				onclick={() => onSelectViewMode(mode.id)}
			>
				{mode.mobileLabel}
			</button>
		{/each}
	{/if}
	{#if showMap}
		<button class="bottom-btn" onclick={onOpenMap}>🗺 Map</button>
	{/if}
	<OptionsMenu items={menuItems} variant="bottom" />
</div>

<style>
	.mobile-bottom-bar {
		display: none;
	}

	@media (max-width: 767px) {
		.mobile-bottom-bar {
			display: flex;
			position: fixed;
			bottom: 0;
			left: 0;
			right: 0;
			height: 52px;
			padding: 0 10px;
			background: #111;
			border-top: 1px solid #2d2d2d;
			z-index: 20;
			justify-content: space-around;
			align-items: center;
		}
	}

	/* Landscape phones use the vertical nav rail instead. */
	@media (max-width: 767px) and (orientation: landscape) {
		.mobile-bottom-bar {
			display: none;
		}
	}

	.bottom-btn {
		flex: 1;
		height: 100%;
		background: transparent;
		border: none;
		color: #888;
		font-size: 0.75rem;
		cursor: pointer;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		transition: color 0.1s;
	}

	@media (hover: hover) and (pointer: fine) {
		.bottom-btn:hover {
			color: #eee;
		}
	}

	.bottom-btn-active {
		color: #e74c3c;
	}
</style>
