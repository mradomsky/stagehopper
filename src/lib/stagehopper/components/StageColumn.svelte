<script lang="ts">
	import PerformanceBlock from './PerformanceBlock.svelte';
	import type { HourMarker } from '../time.js';
	import type { ParticipantMark, Performance, SelectionState } from '../types.js';

	interface Props {
		stageName: string;
		performances: Performance[];
		hourMarkers: HourMarker[];
		gridStartMin: number;
		gridHeightPx: number;
		/** The viewer's participant colour. */
		color: string;
		stateOf: (performanceId: string) => SelectionState;
		marksOf: (performanceId: string) => ParticipantMark[];
		onOpenDetails: (performance: Performance) => void;
		onToggleMark: (performanceId: string) => void;
		/** Whether the viewer favourited this stage. */
		favourite?: boolean;
		/** Toggle the favourite. Omit to render a plain, non-interactive header. */
		onToggleFavourite?: () => void;
		inert?: boolean;
		showMark?: boolean;
		/** Performance id to spotlight after a deep-link, or null. */
		highlightedId?: string | null;
	}

	const {
		stageName,
		performances,
		hourMarkers,
		gridStartMin,
		gridHeightPx,
		color,
		stateOf,
		marksOf,
		onOpenDetails,
		onToggleMark,
		favourite = false,
		onToggleFavourite,
		inert = false,
		showMark = true,
		highlightedId = null
	}: Props = $props();
</script>

<div class="stage-col">
	{#if onToggleFavourite}
		<button
			type="button"
			class="stage-header stage-header-btn"
			class:stage-header-fav={favourite}
			title={stageName}
			aria-pressed={favourite}
			aria-label={favourite ? `Unfavourite ${stageName}` : `Favourite ${stageName}`}
			disabled={inert}
			onclick={onToggleFavourite}
		>
			<span class="stage-header-name">{stageName}</span>
			<span class="stage-header-star" aria-hidden="true">{favourite ? '★' : '☆'}</span>
		</button>
	{:else}
		<div class="stage-header" title={stageName}>{stageName}</div>
	{/if}

	<div class="stage-body" style="height: {gridHeightPx}px;">
		{#each hourMarkers as marker (marker.label)}
			<div class="stage-hour-line" style="top: {marker.top}px;"></div>
		{/each}

		{#each performances as performance (performance.id)}
			<PerformanceBlock
				{performance}
				{gridStartMin}
				{color}
				{inert}
				{showMark}
				domId={`perf-${performance.id}`}
				highlighted={highlightedId === performance.id}
				state={stateOf(performance.id)}
				marks={marksOf(performance.id)}
				onOpen={() => onOpenDetails(performance)}
				onToggleMark={() => onToggleMark(performance.id)}
			/>
		{/each}
	</div>
</div>

<style>
	.stage-col {
		width: var(--col-width);
		flex-shrink: 0;
		border-right: 1px solid #1e1e1e;
	}

	.stage-header {
		height: var(--header-h);
		position: sticky;
		top: 0;
		z-index: 10;
		background: #141414;
		border-bottom: 1px solid #2d2d2d;
		display: flex;
		align-items: center;
		gap: 3px;
		padding: 0 6px;
		overflow: hidden;
		font-size: 0.6rem;
		color: #bbb;
		text-transform: uppercase;
		letter-spacing: 0.4px;
		line-height: 1.2;
	}

	/* Reset button chrome so the favourite-toggle header matches the plain one. */
	.stage-header-btn {
		width: 100%;
		border: none;
		border-bottom: 1px solid #2d2d2d;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.stage-header-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.stage-header-star {
		flex-shrink: 0;
		margin-left: auto;
		color: #555;
		font-size: 0.75rem;
		line-height: 1;
		transition: color 0.12s;
	}

	/* Favourited: a soft lift, not a highlight — the star must not out-shout the
	   now-line or a selected set. Pale warm tone that sits back in the dark theme. */
	.stage-header-fav {
		color: #d8d3c6;
	}

	.stage-header-fav .stage-header-star {
		color: #a89f86;
	}

	@media (hover: hover) and (pointer: fine) {
		.stage-header-btn:not(.stage-header-fav):hover .stage-header-star {
			color: #8a8474;
		}
	}

	.stage-body {
		position: relative;
	}

	.stage-hour-line {
		position: absolute;
		left: 0;
		right: 0;
		border-top: 1px solid #1c1c1c;
	}

	@media (max-width: 767px) {
		.stage-header {
			padding: 0 3px;
			font-size: 0.5rem;
			line-height: 1.1;
		}
	}

	@media (max-width: 479px) {
		.stage-header {
			padding: 0 2px;
			font-size: 0.45rem;
		}
	}
</style>
