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
		inert?: boolean;
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
		inert = false
	}: Props = $props();
</script>

<div class="stage-col">
	<div class="stage-header" title={stageName}>{stageName}</div>

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
		padding: 0 6px;
		overflow: hidden;
		font-size: 0.6rem;
		color: #bbb;
		text-transform: uppercase;
		letter-spacing: 0.4px;
		line-height: 1.2;
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
