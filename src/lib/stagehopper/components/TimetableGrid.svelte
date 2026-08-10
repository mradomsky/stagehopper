<script lang="ts">
	import StageColumn from './StageColumn.svelte';
	import { shouldTriggerDaySwipe } from '../gestures.js';
	import type { HourMarker } from '../time.js';
	import type {
		ParticipantMark,
		Performance,
		SelectionState,
		StageWithPerformances
	} from '../types.js';

	interface Props {
		stages: StageWithPerformances[];
		hourMarkers: HourMarker[];
		gridStartMin: number;
		gridHeightPx: number;
		/** Offset of the current-time line, in pixels from the top of the grid. */
		nowTopPx: number;
		nowVisible: boolean;
		color: string;
		stateOf: (performanceId: string) => SelectionState;
		marksOf: (performanceId: string) => ParticipantMark[];
		onOpenDetails: (performance: Performance, stageName: string) => void;
		onToggleMark: (performanceId: string) => void;
		/** Swipe from a scroll edge to change day: +1 next, -1 previous. */
		onSwipeDay: (delta: number) => void;
		/** Whether the viewer favourited a stage. */
		isFavouriteStage?: (stageName: string) => boolean;
		/** Toggle a stage favourite. Omit to render plain, non-interactive headers. */
		onToggleFavourite?: (stageName: string) => void;
		inert?: boolean;
		showMark?: boolean;
	}

	const {
		stages,
		hourMarkers,
		gridStartMin,
		gridHeightPx,
		nowTopPx,
		nowVisible,
		color,
		stateOf,
		marksOf,
		onOpenDetails,
		onToggleMark,
		onSwipeDay,
		isFavouriteStage,
		onToggleFavourite,
		inert = false,
		showMark = true
	}: Props = $props();

	/** Vertical drift beyond horizontal by this much means the user is scrolling, not swiping. */
	const SCROLL_INTENT_SLOP_PX = 6;

	let scrollEl = $state<HTMLDivElement | null>(null);
	let touchStartX: number | null = null;
	let touchStartY: number | null = null;
	let touchStartScrollLeft = 0;
	let touchIsScroll = false;

	function handleTouchStart(event: TouchEvent) {
		const touch = event.touches[0];
		if (!touch) return;
		touchStartX = touch.clientX;
		touchStartY = touch.clientY;
		touchStartScrollLeft = scrollEl?.scrollLeft ?? 0;
		touchIsScroll = false;
	}

	function handleTouchMove(event: TouchEvent) {
		const touch = event.touches[0];
		if (!touch || touchStartX === null || touchStartY === null) return;
		const dx = touch.clientX - touchStartX;
		const dy = touch.clientY - touchStartY;
		if (!touchIsScroll && Math.abs(dy) > Math.abs(dx) + SCROLL_INTENT_SLOP_PX) {
			touchIsScroll = true;
		}
	}

	function handleTouchEnd(event: TouchEvent) {
		const touch = event.changedTouches[0];
		if (!touch || touchStartX === null || touchStartY === null || touchIsScroll) {
			touchStartX = null;
			touchStartY = null;
			return;
		}

		const dx = touch.clientX - touchStartX;
		const dy = touch.clientY - touchStartY;
		const maxScrollLeft = Math.max(0, (scrollEl?.scrollWidth ?? 0) - (scrollEl?.clientWidth ?? 0));

		if (
			shouldTriggerDaySwipe({ dx, dy, scrollLeftAtStart: touchStartScrollLeft, maxScrollLeft })
		) {
			onSwipeDay(dx < 0 ? 1 : -1);
		}

		touchStartX = null;
		touchStartY = null;
	}
</script>

<div
	class="grid-scroll"
	role="region"
	aria-label="Festival timetable"
	bind:this={scrollEl}
	ontouchstart={handleTouchStart}
	ontouchmove={handleTouchMove}
	ontouchend={handleTouchEnd}
>
	<div class="grid-inner">
		<div class="time-col">
			<div class="time-corner"></div>
			<div class="time-body" style="height: {gridHeightPx}px;">
				{#each hourMarkers as marker (marker.label)}
					<div class="hour-line" style="top: {marker.top}px;"></div>
					<div class="hour-label" style="top: {marker.top}px;">{marker.label}</div>
				{/each}
				{#if nowVisible}
					<div class="now-line now-line-time" style="top: {nowTopPx}px;"></div>
				{/if}
			</div>
		</div>

		{#each stages as stage (stage.name)}
			<StageColumn
				stageName={stage.name}
				performances={stage.performances}
				{hourMarkers}
				{gridStartMin}
				{gridHeightPx}
				{color}
				{stateOf}
				{marksOf}
				{inert}
				{showMark}
				favourite={isFavouriteStage?.(stage.name) ?? false}
				onToggleFavourite={onToggleFavourite ? () => onToggleFavourite(stage.name) : undefined}
				onOpenDetails={(performance) => onOpenDetails(performance, stage.name)}
				{onToggleMark}
			/>
		{/each}

		<!-- One continuous now-line across every stage column, so the gradient animation
		     flows without restarting at each column boundary. -->
		{#if nowVisible}
			<div
				class="now-line now-line-grid"
				style="top: calc(var(--header-h) + {nowTopPx}px);"
			></div>
		{/if}
	</div>
</div>

<style>
	.grid-scroll {
		flex: 1;
		overflow: auto;
		position: relative;
	}

	/* Column metrics live here so orientation and window changes re-flow the grid. */
	.grid-inner {
		--col-width: 160px;
		--time-col-w: 52px;
		--header-h: 44px;
		display: inline-flex;
		min-height: 100%;
		position: relative;
	}

	.time-col {
		width: var(--time-col-w);
		position: sticky;
		left: 0;
		z-index: 15;
		background: #111;
		border-right: 1px solid #2d2d2d;
		flex-shrink: 0;
	}

	.time-corner {
		height: var(--header-h);
		position: sticky;
		top: 0;
		background: #111;
		border-bottom: 1px solid #2d2d2d;
		z-index: 25;
	}

	.time-body {
		position: relative;
	}

	.hour-line {
		position: absolute;
		left: 0;
		right: 0;
		border-top: 1px solid #1e1e1e;
	}

	.hour-label {
		position: absolute;
		left: 2px;
		right: 2px;
		font-size: 0.6rem;
		color: #666;
		transform: translateY(-50%);
		white-space: nowrap;
	}

	/* Current time line. */
	.now-line {
		position: absolute;
		left: 0;
		/* Bleed 1px past the row's own right edge so the line bridges the last
		   stage-col's border instead of appearing to duck behind it. */
		right: -1px;
		height: 3px;
		overflow: hidden;
		z-index: 5;
		pointer-events: none;
		box-shadow: 0 0 6px 1px rgba(255, 255, 255, 0.35);
	}

	.now-line-grid {
		left: var(--time-col-w);
	}

	.now-line-time {
		left: 0;
		right: 0;
	}

	/* Animated via transform on a pseudo-element rather than background-position:
	   background-position animation forces a main-thread repaint every frame, which
	   is expensive enough to stall on mobile. transform is compositor-only. */
	.now-line::before {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		/* Extend one tile past the right edge so the translate never reveals empty space. */
		right: -280px;
		background: repeating-linear-gradient(
			90deg,
			rgba(255, 130, 130, 0.7) 0%,
			rgba(255, 190, 130, 0.7) 14.3%,
			rgba(240, 240, 130, 0.7) 28.6%,
			rgba(140, 230, 140, 0.7) 42.9%,
			rgba(130, 190, 240, 0.7) 57.1%,
			rgba(165, 140, 230, 0.7) 71.4%,
			rgba(230, 130, 200, 0.7) 85.7%,
			rgba(255, 130, 130, 0.7) 100%
		);
		background-size: 280px 100%;
		animation: now-line-flow 24s linear infinite;
	}

	@keyframes now-line-flow {
		from {
			transform: translate3d(0, 0, 0);
		}
		to {
			transform: translate3d(-280px, 0, 0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.now-line::before {
			animation: none;
		}
	}

	@media (max-width: 767px) {
		.grid-inner {
			--col-width: 100px;
			--time-col-w: 40px;
			--header-h: 40px;
		}

		.grid-scroll {
			padding-bottom: 52px; /* Clears the mobile bottom bar. */
		}

		.hour-label {
			font-size: 0.5rem;
			left: 1px;
			right: 1px;
		}
	}

	@media (max-width: 479px) {
		.grid-inner {
			--col-width: 80px;
			--time-col-w: 35px;
		}

		.hour-label {
			font-size: 0.45rem;
		}
	}

	@media (max-width: 767px) and (orientation: landscape) {
		.grid-scroll {
			padding-bottom: 0;
			margin-left: 44px;
		}
	}
</style>
