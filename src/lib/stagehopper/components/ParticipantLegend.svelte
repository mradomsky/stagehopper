<script lang="ts">
	import type { RoomSelection } from '../types.js';

	interface Props {
		/** Dots mirroring the day tabs, as a swipe affordance on phones. */
		dayCount: number;
		currentDayIdx: number;
		/**
		 * False while browsing a lineup as a guest, where there are no picks to filter.
		 * Kept separate from `participants` so the All chip is stable from first paint,
		 * rather than appearing once the first fetch resolves.
		 */
		showFilters: boolean;
		participants: RoomSelection[];
		viewerUserId: string;
		showingAll: boolean;
		isSelected: (userId: string) => boolean;
		onShowAll: () => void;
		onToggleParticipant: (userId: string) => void;
	}

	const {
		dayCount,
		currentDayIdx,
		showFilters,
		participants,
		viewerUserId,
		showingAll,
		isSelected,
		onShowAll,
		onToggleParticipant
	}: Props = $props();
</script>

<div class="legend-bar">
	<div class="day-dots" aria-hidden="true">
		{#each { length: dayCount }, index}
			<span class="day-dot" class:day-dot-active={currentDayIdx === index}></span>
		{/each}
	</div>

	{#if showFilters}
		<button
			type="button"
			class="legend-entry legend-entry-all"
			class:legend-entry-active={showingAll}
			onclick={onShowAll}
		>
			<span class="legend-name legend-name-all">All</span>
		</button>

		{#each participants as participant (participant.userId)}
			{@const isViewer = participant.userId === viewerUserId}
			<button
				type="button"
				class="legend-entry"
				class:legend-entry-active={isSelected(participant.userId)}
				class:legend-entry-me={isViewer}
				onclick={() => onToggleParticipant(participant.userId)}
				disabled={isViewer}
				aria-pressed={isSelected(participant.userId)}
			>
				<span class="legend-dot" style="background: {participant.color};"></span>
				<span class="legend-name" class:legend-me={isViewer}>
					{participant.name}{isViewer ? ' (you)' : ''}
				</span>
			</button>
		{/each}
	{/if}
</div>

<style>
	.legend-bar {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0 0.75rem;
		height: 34px;
		background: #111;
		border-bottom: 1px solid #2d2d2d;
		flex-shrink: 0;
		overflow-x: auto;
		overflow-y: hidden;
	}

	.legend-entry {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		white-space: nowrap;
		background: transparent;
		border: 1px solid #343434;
		border-radius: 999px;
		padding: 0.18rem 0.55rem;
		cursor: pointer;
		transition:
			background 0.12s,
			border-color 0.12s,
			opacity 0.12s;
	}

	@media (hover: hover) and (pointer: fine) {
		.legend-entry:hover:not(:disabled) {
			background: #1e1e1e;
			border-color: #505050;
		}
	}

	.legend-entry:disabled {
		cursor: default;
	}

	.legend-entry-active {
		background: #232323;
		border-color: #5b5b5b;
	}

	.legend-entry-all {
		padding-inline: 0.75rem;
	}

	.legend-entry-me {
		border-color: #5a4740;
	}

	.legend-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.legend-name {
		font-size: 0.75rem;
		color: #888;
	}

	.legend-name-all {
		color: #d2d2d2;
	}

	.legend-me {
		color: #fffaf0;
		font-weight: 600;
	}

	/* Swipe indicator, phones only. */
	.day-dots {
		display: none;
		gap: 5px;
		align-items: center;
		flex-shrink: 0;
	}

	.day-dot {
		display: block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #444;
		transition: background 0.2s;
	}

	.day-dot-active {
		background: #e74c3c;
	}

	@media (max-width: 767px) {
		.day-dots {
			display: flex;
		}

		.legend-bar {
			padding: 0 0.5rem;
			height: 32px;
			gap: 0.7rem;
		}

		.legend-entry {
			gap: 0.25rem;
		}

		.legend-name {
			font-size: 0.65rem;
		}
	}

	@media (max-width: 479px) {
		.legend-bar {
			padding: 0 0.4rem;
			height: 28px;
			gap: 0.5rem;
		}

		.legend-name {
			font-size: 0.6rem;
		}
	}

	@media (max-width: 767px) and (orientation: landscape) {
		.legend-bar {
			position: absolute;
			left: 44px;
			top: 0;
			width: auto;
			height: 44px;
			flex-direction: row;
			z-index: 12;
		}
	}
</style>
