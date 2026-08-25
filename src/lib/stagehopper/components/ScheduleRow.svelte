<script lang="ts">
	import { artistThumbHue, type PickTiming } from '../picks.js';
	import { getParticipantInitial, markDotStyle } from '../selections.js';
	import type { ParticipantMark, Performance, SelectionState } from '../types.js';
	import type { Snippet } from 'svelte';

	interface Props {
		performance: Performance;
		/** How the set relates to the current moment — dims the past, flags now/soon. */
		timing: PickTiming;
		/** The viewer's own mark, shown as the attending/maybe pill. */
		state: SelectionState;
		/** Other participants who marked this set. */
		marks: ParticipantMark[];
		/** The stage's admin-set colour, or undefined for the default neutral text. */
		stageColor?: string;
		/** Trailing control: the Picks tab's bell, or the list layout's star. */
		trailing?: Snippet;
		/** DOM id used as a deep-link anchor target (e.g. `perf-{id}`). */
		domId?: string;
		/** Briefly flag this row after a deep-link. */
		highlighted?: boolean;
		onOpen: () => void;
	}

	const {
		performance,
		timing,
		state,
		marks,
		stageColor,
		trailing,
		domId,
		highlighted = false,
		onOpen
	}: Props = $props();

	/** Dots beyond this many collapse into a "+N" chip, so a big room can't blow out the row. */
	const MAX_DOTS = 5;

	const src = $derived(performance.artists?.[0]?.image ?? performance.artistImage ?? null);
	const markLabel = $derived(state === 2 ? 'maybe' : 'attending');

	function onThumbError(event: Event) {
		(event.currentTarget as HTMLImageElement).style.display = 'none';
	}
</script>

<div
	id={domId}
	class="pick-item"
	class:pick-item-past={timing === 'past'}
	class:pick-item-highlight={highlighted}
	data-pick-id={performance.id}
	role="button"
	tabindex="0"
	onclick={onOpen}
	onkeydown={(event) => {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault(); // Space would otherwise scroll the page, as on a real button.
		onOpen();
	}}
>
	<span class="pick-thumb" style="background: hsl({artistThumbHue(performance.artist)}, 35%, 22%);">
		{#if src}
			<img {src} alt="" loading="lazy" onerror={onThumbError} />
		{:else}
			<span class="pick-thumb-initial">{performance.artist[0]?.toUpperCase() ?? '?'}</span>
		{/if}
	</span>

	<span class="pick-info">
		<span class="pick-artist">{performance.artist}</span>
		<span class="pick-meta">{performance.startTime}–{performance.endTime}</span>
		<span class="pick-meta-row">
			<span class="pick-stage" style={stageColor ? `color: ${stageColor};` : ''}
				>{performance.stage}</span
			>
			{#if timing === 'now'}
				<span class="pick-pill pick-pill-now">Playing now</span>
			{:else if timing === 'soon'}
				<span class="pick-pill pick-pill-soon">Playing soon</span>
			{:else if state > 0}
				<span class="pick-pill">{markLabel}</span>
			{/if}
			{#if marks.length > 0}
				<span class="pick-dots">
					{#each marks.slice(0, MAX_DOTS) as mark (mark.userId)}
						{@const dot = markDotStyle(mark)}
						<span
							class="pick-dot"
							style="background: {dot.background}; border-color: {dot.border};"
							title={mark.name}
						>
							{getParticipantInitial(mark.name)}
						</span>
					{/each}
					{#if marks.length > MAX_DOTS}
						<span class="pick-dot pick-dot-more">+{marks.length - MAX_DOTS}</span>
					{/if}
				</span>
			{/if}
		</span>
	</span>

	{@render trailing?.()}
</div>

<style>
	.pick-item {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		width: 100%;
		border: none;
		border-bottom: 1px solid #2a2a2a;
		background: transparent;
		padding: 0.6rem 0.15rem;
		text-align: left;
		cursor: pointer;
		font: inherit;
		color: inherit;
		transition: opacity 0.15s;
	}

	.pick-item-past {
		opacity: 0.7;
	}

	/* Deep-link spotlight, matching the grid block's: a couple of bright pulses, then it settles. */
	.pick-item-highlight {
		animation: pick-flash 1s ease-out 2;
	}

	@keyframes pick-flash {
		0% {
			box-shadow: inset 0 0 0 2px rgba(255, 250, 240, 0.9);
		}
		100% {
			box-shadow: inset 0 0 0 2px rgba(255, 250, 240, 0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.pick-item-highlight {
			animation: none;
			box-shadow: inset 0 0 0 2px rgba(255, 250, 240, 0.9);
		}
	}

	@media (hover: hover) and (pointer: fine) {
		.pick-item:hover .pick-artist {
			color: #ffd27f;
		}
	}

	.pick-thumb {
		flex-shrink: 0;
		width: 56px;
		height: 56px;
		border-radius: 8px;
		overflow: hidden;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.pick-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.pick-thumb-initial {
		color: rgba(255, 255, 255, 0.75);
		font-size: 1.3rem;
		font-weight: 700;
	}

	.pick-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.pick-artist {
		font-size: 0.9rem;
		font-weight: 600;
		color: #fffaf0;
	}

	.pick-meta {
		font-size: 0.75rem;
		color: #999;
	}

	.pick-meta-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.1rem;
	}

	.pick-stage {
		font-size: 0.75rem;
		color: #777;
	}

	.pick-pill {
		display: inline-block;
		padding: 0 0.5em;
		border: 1px solid #555;
		border-radius: 999px;
		font-size: 0.65rem;
		color: #999;
		line-height: 1.5;
		white-space: nowrap;
	}

	/* Same rainbow the timetable's now-line uses, so "playing now" reads as the same
	   live signal in both places. */
	.pick-pill-now {
		border-color: transparent;
		color: #fff;
		background: repeating-linear-gradient(
			90deg,
			rgba(255, 130, 130, 0.9) 0%,
			rgba(255, 190, 130, 0.9) 14.3%,
			rgba(240, 240, 130, 0.9) 28.6%,
			rgba(140, 230, 140, 0.9) 42.9%,
			rgba(130, 190, 240, 0.9) 57.1%,
			rgba(165, 140, 230, 0.9) 71.4%,
			rgba(230, 130, 200, 0.9) 85.7%,
			rgba(255, 130, 130, 0.9) 100%
		);
		background-size: 280px 100%;
		animation: pick-pill-now-flow 24s linear infinite;
	}

	@keyframes pick-pill-now-flow {
		from {
			background-position: 0 0;
		}
		to {
			background-position: -280px 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.pick-pill-now {
			animation: none;
		}
	}

	.pick-pill-soon {
		border-color: #f39c12;
		color: #f39c12;
	}

	.pick-dots {
		display: inline-flex;
		gap: 0.2rem;
	}

	.pick-dot {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		border: 1px solid;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.55rem;
		font-weight: 700;
		color: #fff;
	}

	.pick-dot-more {
		background: #333;
		border-color: #555;
		color: #ccc;
		font-weight: 600;
	}
</style>
