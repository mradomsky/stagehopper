<script lang="ts">
	import { onMount, tick } from 'svelte';
	import ScheduleDayHeader from './ScheduleDayHeader.svelte';
	import ScheduleRow from './ScheduleRow.svelte';
	import { activeDayIndex } from '../schedule-list.js';
	import type { ScheduleDayGroup } from '../schedule-list.js';
	import type { ParticipantMark, SelectionState } from '../types.js';

	interface Props {
		groups: ScheduleDayGroup[];
		/** The festival day currently in progress, for the day header's TODAY badge. */
		todayDate: string | null;
		/** Stage name → admin-set colour. A stage with no entry uses the default neutral text. */
		stageColors?: Record<string, string>;
		/** The day the room is on. Changing it from outside (the day tabs) jumps the list. */
		currentDayIdx: number;
		/** Row to anchor on when the list opens; null to sit at the current day's header. */
		scrollTargetId: string | null;
		stateOf: (performanceId: string) => SelectionState;
		marksOf: (performanceId: string) => ParticipantMark[];
		onOpen: (performanceId: string) => void;
		/** Cycle the viewer's mark — the same star as the grid's blocks. */
		onToggleMark: (performanceId: string) => void;
		/** Scrolling into a day's rows reports it back, so the day tabs track the list. */
		onDayInView: (index: number) => void;
		/** Performance id to spotlight after a deep-link, or null. */
		highlightedId?: string | null;
	}

	const {
		groups,
		todayDate,
		stageColors,
		currentDayIdx,
		scrollTargetId,
		stateOf,
		marksOf,
		onOpen,
		onToggleMark,
		onDayInView,
		highlightedId = null
	}: Props = $props();

	/**
	 * Each day is its own section, so the day being read is the last one whose top has passed
	 * the top of the list. This is the slack allowed for sub-pixel rounding.
	 */
	const DAY_TOP_TOLERANCE_PX = 2;

	/** Treat this close to the bottom as "scrolled to the end" — see {@link activeDayIndex}. */
	const END_SLOP_PX = 2;
	/**
	 * How long a programmatic scroll is given to land before the list starts reporting the day
	 * in view again. A frame callback would be the natural clock here, but it is paused while
	 * the tab is in the background — and a jump that never ended would freeze the day tabs.
	 */
	const JUMP_SETTLE_MS = 120;

	let listEl: HTMLDivElement | undefined = $state();

	/** Set while a programmatic jump is in flight, so the days it flies past don't report in. */
	let jumping = false;
	let jumpTimer: ReturnType<typeof setTimeout> | undefined;
	/**
	 * The day index the list and the room last agreed on. It is what tells a day picked in
	 * the nav from one this list reported itself: the spy records the day here *before*
	 * handing it up, so the change coming back down is recognised and not scrolled to again.
	 */
	let appliedDayIdx = -1;

	function dayElements(): HTMLElement[] {
		return [...(listEl?.querySelectorAll<HTMLElement>('.day-group') ?? [])];
	}

	function recomputeActiveDay() {
		if (!listEl || jumping) return;
		const listTop = listEl.getBoundingClientRect().top;
		const offsets = dayElements().map((el) => el.getBoundingClientRect().top - listTop);
		const atEnd = listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - END_SLOP_PX;
		const index = activeDayIndex(offsets, atEnd, DAY_TOP_TOLERANCE_PX);
		if (index < 0 || index === appliedDayIdx) return;
		appliedDayIdx = index;
		onDayInView(index);
	}

	/** Hold off the scroll-spy until the scroll just started has settled. */
	function beginJump() {
		jumping = true;
		clearTimeout(jumpTimer);
		jumpTimer = setTimeout(() => (jumping = false), JUMP_SETTLE_MS);
	}

	/** Scroll a day to the top of the list, without animating across the days between. */
	function jumpToDay(index: number) {
		const group = dayElements()[index];
		if (!group) return;
		beginJump();
		group.scrollIntoView({ block: 'start' });
	}

	onMount(() => {
		// A plain scroll listener rather than an IntersectionObserver: a day section stays on
		// screen for a whole day of scrolling, so the crossings an observer would report are
		// far rarer than the moments the answer changes. Each call reads one rect per day — a
		// handful — and bails before touching state unless the day actually changed.
		listEl?.addEventListener('scroll', recomputeActiveDay, { passive: true });

		// The list opens where the viewer already was: the current day, and within it the
		// current moment. Re-runs on every switch into this layout, since the component is
		// mounted fresh each time.
		void tick().then(() => {
			appliedDayIdx = currentDayIdx;
			// A deep-linked set outranks the current moment: that is what the viewer tapped.
			const target = highlightedId ?? scrollTargetId;
			if (target && scrollToRow(target)) return;
			jumpToDay(currentDayIdx);
		});

		return () => {
			listEl?.removeEventListener('scroll', recomputeActiveDay);
			clearTimeout(jumpTimer);
		};
	});

	function scrollToRow(performanceId: string): boolean {
		// A plain attribute match rather than a CSS selector built from the id, since
		// performance ids aren't guaranteed to be valid unescaped CSS token text.
		for (const el of listEl?.querySelectorAll<HTMLElement>('[data-pick-id]') ?? []) {
			if (el.dataset.pickId !== performanceId) continue;
			beginJump();
			el.scrollIntoView({ block: 'center' });
			return true;
		}
		return false;
	}

	/** A day picked in the nav (or landed on by a deep-link) scrolls the list to that day. */
	$effect(() => {
		const index = currentDayIdx;
		if (index === appliedDayIdx) return;
		appliedDayIdx = index;
		jumpToDay(index);
	});

	function markLabel(state: SelectionState): string {
		return state === 0 ? 'Mark as going' : state === 1 ? 'Marked as going' : 'Marked as maybe';
	}
</script>

<div class="list-view" bind:this={listEl}>
	{#each groups as group (group.date)}
		<!-- One section per day: it bounds the sticky header, so headers hand over at the top
		     of the list instead of piling up there, and it gives the scroll-spy a box to measure. -->
		<section class="day-group">
			<ScheduleDayHeader date={group.date} label={group.label} today={group.date === todayDate} />
			{#if group.rows.length === 0}
				<p class="list-empty-day">Nothing scheduled.</p>
			{/if}
			{#each group.rows as row (row.performance.id)}
				{@const performance = row.performance}
				{@const state = stateOf(performance.id)}
				<ScheduleRow
					{performance}
					timing={row.timing}
					{state}
					marks={marksOf(performance.id)}
					stageColor={stageColors?.[performance.stage]}
					domId={`perf-${performance.id}`}
					highlighted={highlightedId === performance.id}
					onOpen={() => onOpen(performance.id)}
				>
					{#snippet trailing()}
						<button
							type="button"
							class="list-star"
							style={state === 1
								? 'color: #ffd700;'
								: state === 2
									? 'color: #ffd700; opacity: 0.55;'
									: ''}
							onclick={(event) => {
								event.stopPropagation();
								onToggleMark(performance.id);
							}}
							onkeydown={(event) => event.stopPropagation()}
							aria-label={markLabel(state)}
						>
							★
						</button>
					{/snippet}
				</ScheduleRow>
			{/each}
		</section>
	{/each}
</div>

<style>
	.list-view {
		flex: 1;
		overflow-y: auto;
		padding: 0 0.75rem 1rem;
	}

	.list-empty-day {
		color: #777;
		font-size: 0.8rem;
		font-style: italic;
		margin: 0;
		padding: 0.9rem 0.15rem;
		border-bottom: 1px solid #2a2a2a;
	}

	.list-star {
		flex-shrink: 0;
		align-self: flex-start;
		margin-top: -0.2rem;
		width: 38px;
		height: 38px;
		border: none;
		border-radius: 50%;
		background: transparent;
		color: #999;
		font-size: 1.6rem;
		line-height: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		cursor: pointer;
		transition: color 0.1s;
	}

	@media (hover: hover) and (pointer: fine) {
		.list-star:hover {
			background: #2a2a2a;
		}
	}

	@media (max-width: 767px) {
		.list-view {
			padding-bottom: 60px; /* Clears the mobile bottom bar. */
		}
	}
</style>
