<script lang="ts">
	import { colorWithOpacity, getParticipantInitial, getSelectionVisuals } from '../selections.js';
	import { durationPx, timeToGridMin, timeToTopPx } from '../time.js';
	import type { ParticipantMark, Performance, SelectionState } from '../types.js';

	interface Props {
		performance: Performance;
		/** Minutes at the top of the grid, used to place the block. */
		gridStartMin: number;
		/** The viewer's own mark on this performance. */
		state: SelectionState;
		/** The viewer's participant colour. */
		color: string;
		/** Other participants who marked this performance. */
		marks: ParticipantMark[];
		/** Open the artist details card. */
		onOpen: () => void;
		/** Cycle the viewer's mark. */
		onToggleMark: () => void;
		/** Disables interaction while a blocking modal is up. */
		inert?: boolean;
		/** Show the "mark as going" star. Off in contexts with no viewer to mark for, e.g. the admin editor. */
		showMark?: boolean;
	}

	const {
		performance,
		gridStartMin,
		state,
		color,
		marks,
		onOpen,
		onToggleMark,
		inert = false,
		showMark = true
	}: Props = $props();

	/** Below this height there is no room for the time line under the artist name. */
	const TIME_LABEL_MIN_HEIGHT_PX = 28;
	/** Sets shorter than this have no room for the star; mark them via the details popup instead. */
	const MARK_MIN_DURATION_MIN = 30;

	const top = $derived(timeToTopPx(performance.startTime, gridStartMin));
	const height = $derived(durationPx(performance.startTime, performance.endTime));
	const durationMin = $derived(
		timeToGridMin(performance.endTime) - timeToGridMin(performance.startTime)
	);
	const visuals = $derived(getSelectionVisuals(color, state));
	const markLabel = $derived(
		state === 0 ? 'Mark as going' : state === 1 ? 'Marked as going' : 'Marked as maybe'
	);
</script>

<div
	class="perf-block"
	style="top: {top}px; height: {height}px; background: {visuals.background}; border-color: {visuals.border};"
	role="button"
	tabindex={inert ? -1 : 0}
	onclick={onOpen}
	onkeydown={(event) => event.key === 'Enter' && onOpen()}
>
	<span class="perf-artist">{performance.artist}</span>
	{#if height > TIME_LABEL_MIN_HEIGHT_PX}
		<span class="perf-time">{performance.startTime}–{performance.endTime}</span>
		{#if state > 0}
			<span class="perf-selection">{state === 1 ? 'attending' : 'maybe'}</span>
		{/if}
	{/if}

	{#if marks.length > 0}
		<div class="perf-dots">
			{#each marks as mark (mark.userId)}
				<span
					class="perf-dot"
					style="background: {colorWithOpacity(
						mark.color,
						mark.state === 2 ? 0.35 : 0.92
					)}; border-color: {colorWithOpacity(mark.color, mark.state === 2 ? 0.7 : 1)};"
					title={mark.name}
				>
					{getParticipantInitial(mark.name)}
				</span>
			{/each}
		</div>
	{/if}

	{#if showMark && durationMin >= MARK_MIN_DURATION_MIN}
		<button
			class="perf-star"
			class:perf-star-marked={state > 0}
			style={state > 0 ? `color: ${colorWithOpacity(color, state === 1 ? 1 : 0.55)};` : ''}
			onpointerup={(event) => {
				event.stopPropagation();
				onToggleMark();
			}}
			onclick={(event) => event.stopPropagation()}
			aria-label={markLabel}
			tabindex={inert ? -1 : 0}
		>
			{state > 0 ? '★' : '☆'}
		</button>
	{/if}
</div>

<style>
	.perf-block {
		position: absolute;
		left: 2px;
		right: 2px;
		border: 1px solid #3a3a3a;
		border-radius: 3px;
		padding: 2px 4px;
		overflow: hidden;
		cursor: pointer;
		transition: filter 0.1s;
	}

	@media (hover: hover) and (pointer: fine) {
		.perf-block:hover {
			filter: brightness(1.15);
		}
	}

	.perf-artist {
		display: block;
		font-size: 0.65rem;
		font-weight: 700;
		color: #fffaf0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 1.25;
	}

	.perf-time {
		display: block;
		font-size: 0.55rem;
		color: #999;
		line-height: 1.2;
	}

	/* Text echo of the colour signal — a small grey pill on its own line under the time. */
	.perf-selection {
		display: inline-block;
		margin-top: 2px;
		padding: 0 0.4em;
		border: 1px solid #555;
		border-radius: 999px;
		font-size: 0.55rem;
		color: #999;
		line-height: 1.4;
		white-space: nowrap;
	}

	/* Bottom-left, wrapping upward into multiple rows. The right edge stops short of
	   the bottom-right star so badges never sit on top of it. */
	.perf-dots {
		position: absolute;
		bottom: 2px;
		left: 2px;
		right: 32px;
		display: flex;
		gap: 3px;
		flex-wrap: wrap;
		justify-content: flex-start;
	}

	.perf-dot {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 1px solid transparent;
		color: #fffaf0;
		font-size: 0.48rem;
		font-weight: 700;
		line-height: 1;
		text-transform: uppercase;
		box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
	}

	.perf-star {
		position: absolute;
		bottom: 2px;
		right: 2px;
		width: 28px;
		height: 28px;
		border: none;
		background: transparent;
		color: #555;
		font-size: 1.2rem;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		padding: 0;
		line-height: 1;
		transition: color 0.1s;
		z-index: 2;
	}

	@media (hover: hover) and (pointer: fine) {
		.perf-star:not(.perf-star-marked):hover {
			color: #f1c40f;
		}
	}

	@media (max-width: 767px) {
		.perf-block {
			left: 1px;
			right: 1px;
		}

		.perf-artist {
			font-size: 0.6rem;
			line-height: 1.2;
		}

		.perf-time {
			font-size: 0.45rem;
		}

		.perf-selection {
			font-size: 0.45rem;
		}

		.perf-dots {
			bottom: 1px;
			left: 1px;
			right: 30px;
		}

		.perf-dot {
			width: 12px;
			height: 12px;
			font-size: 0.42rem;
		}
	}

	@media (max-width: 479px) {
		.perf-artist {
			font-size: 0.55rem;
		}

		.perf-time {
			font-size: 0.4rem;
		}

		.perf-selection {
			font-size: 0.4rem;
		}
	}
</style>
