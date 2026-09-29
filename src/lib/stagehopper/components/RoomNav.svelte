<script lang="ts">
	import OptionsMenu from './OptionsMenu.svelte';
	import { VIEW_MODES } from '../view-modes.js';
	import type { MenuItem, TimetableDay, ViewMode } from '../types.js';

	interface Props {
		days: TimetableDay[];
		currentDayIdx: number;
		viewMode: ViewMode;
		/** Guests browsing a lineup have no picks, so the view tabs are hidden. */
		showViewTabs: boolean;
		menuItems: MenuItem[];
		/** Whether a festival map is available. */
		showMap?: boolean;
		onSelectDay: (index: number) => void;
		onSelectViewMode: (mode: ViewMode) => void;
		/** Open the map overlay. */
		onOpenMap?: () => void;
	}

	const {
		days,
		currentDayIdx,
		viewMode,
		showViewTabs,
		showMap,
		menuItems,
		onSelectDay,
		onSelectViewMode,
		onOpenMap
	}: Props = $props();
</script>

<nav class="sh-nav">
	<a class="sh-brand" href="/">🎵 StageHopper</a>

	<div class="day-tabs">
		{#each days as day, index (day.date)}
			<button
				class="sh-btn-sm tab"
				class:tab-active={currentDayIdx === index}
				onclick={() => onSelectDay(index)}
			>
				{day.label}
			</button>
		{/each}
	</div>

	<div class="nav-right">
		{#if showViewTabs}
			{#each VIEW_MODES as mode (mode.id)}
				<button
					class="sh-btn-sm tab"
					class:tab-active={viewMode === mode.id}
					onclick={() => onSelectViewMode(mode.id)}
				>
					{mode.label}
				</button>
			{/each}
		{/if}
		{#if showMap}
			<button class="sh-btn-sm tab" onclick={onOpenMap}>🗺 Map</button>
		{/if}
		<OptionsMenu items={menuItems} />
	</div>
</nav>

<style>
	.sh-nav {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0 0.75rem;
		height: 48px;
		background: #111;
		border-bottom: 1px solid #2d2d2d;
		flex-shrink: 0;
		overflow-x: auto;
		overflow-y: hidden;
	}

	.sh-brand {
		font-size: 0.9rem;
		font-weight: 700;
		color: #fffaf0;
		white-space: nowrap;
		margin-right: 0.5rem;
		text-decoration: none;
	}

	@media (hover: hover) and (pointer: fine) {
		.sh-brand:hover {
			color: #ffd27f;
		}
	}

	.day-tabs {
		display: flex;
		gap: 0.25rem;
	}

	.nav-right {
		display: flex;
		gap: 0.25rem;
		margin-left: auto;
	}

	.tab-active {
		background: #2a2a2a;
		border-color: #e74c3c;
		color: #fffaf0;
	}

	@media (max-width: 767px) {
		.sh-nav {
			padding: 0 0.5rem;
			height: 44px;
			gap: 0.3rem;
		}

		.sh-brand {
			font-size: 0.8rem;
			margin-right: 0.3rem;
		}

		.day-tabs {
			gap: 0.1rem;
		}

		.tab {
			padding: 0.25rem 0.5rem;
			font-size: 0.65rem;
			min-height: 32px;
			display: flex;
			align-items: center;
		}

		/* View tabs move to the bottom bar on phones; the menu stays reachable. */
		.nav-right .tab {
			display: none;
		}
	}

	@media (max-width: 479px) {
		.sh-nav {
			padding: 0 0.4rem;
			height: 40px;
			gap: 0.2rem;
		}

		.sh-brand {
			font-size: 0.7rem;
			margin-right: 0.2rem;
		}

		.tab {
			padding: 0.2rem 0.4rem;
			font-size: 0.6rem;
			min-height: 30px;
		}
	}

	/* Landscape phones: the nav becomes a vertical rail down the left edge. */
	@media (max-width: 767px) and (orientation: landscape) {
		.sh-nav {
			writing-mode: vertical-rl;
			transform: rotate(180deg);
			width: 44px;
			height: auto;
			padding: 0;
			flex-direction: column;
		}

		.sh-brand {
			display: none;
		}

		.day-tabs {
			flex-direction: column;
		}

		.nav-right {
			flex-direction: column;
		}

		.nav-right .tab {
			display: flex;
		}
	}
</style>
