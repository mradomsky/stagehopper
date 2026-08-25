<script lang="ts">
	import { tick } from 'svelte';
	import BellIcon from './BellIcon.svelte';
	import { artistThumbHue, type PickTiming } from '../picks.js';
	import { getParticipantInitial, markDotStyle } from '../selections.js';
	import type { ParticipantMark, Performance, SelectionState } from '../types.js';

	interface PickRow {
		performance: Performance;
		timing: PickTiming;
	}

	interface PickGroup {
		date: string;
		label: string;
		performances: PickRow[];
	}

	interface Props {
		groups: PickGroup[];
		/** The festival day currently in progress, for the day header's TODAY badge. */
		todayDate: string | null;
		/** The row to centre on open; null once every pick is in the past. */
		scrollTargetId: string | null;
		stateOf: (performanceId: string) => SelectionState;
		marksOf: (performanceId: string) => ParticipantMark[];
		/** Whether this pick would notify — the bell's on/off state. */
		notifyStateOf: (performanceId: string) => boolean;
		/** Whether push is on for this account at all. Off shows a muted bell. */
		notificationsAvailable: boolean;
		onOpen: (performanceId: string) => void;
		/** Flip a performance's bell, or (when push is off entirely) offer to turn it on. */
		onToggleBell: (performanceId: string) => void;
		/** Switch back to the timetable, offered from the empty state. */
		onBrowseTimetable: () => void;
	}

	const {
		groups,
		todayDate,
		scrollTargetId,
		stateOf,
		marksOf,
		notifyStateOf,
		notificationsAvailable,
		onOpen,
		onToggleBell,
		onBrowseTimetable
	}: Props = $props();

	/** Dots beyond this many collapse into a "+N" chip, so a big room can't blow out the row. */
	const MAX_DOTS = 5;

	let listEl: HTMLDivElement | undefined = $state();

	/** Re-centre whenever the tab is (re)opened on a new target — never mid-scroll. */
	$effect(() => {
		const id = scrollTargetId;
		if (!id || !listEl) return;
		void tick().then(() => {
			// A plain attribute match rather than a CSS selector built from `id`, since
			// performance ids aren't guaranteed to be valid unescaped CSS token text.
			for (const el of listEl?.querySelectorAll<HTMLElement>('[data-pick-id]') ?? []) {
				if (el.dataset.pickId === id) {
					el.scrollIntoView({ block: 'center' });
					break;
				}
			}
		});
	});

	function thumbSrc(performance: Performance): string | null {
		return performance.artists?.[0]?.image ?? performance.artistImage ?? null;
	}

	function markLabel(state: SelectionState): string {
		return state === 2 ? 'maybe' : 'attending';
	}

	function onThumbError(event: Event) {
		(event.currentTarget as HTMLImageElement).style.display = 'none';
	}
</script>

<div class="picks-view" bind:this={listEl}>
	{#if groups.length === 0}
		<div class="picks-empty">
			<p>No picks yet — tap ★ on a set to add it here.</p>
			<button type="button" class="sh-btn sh-btn-secondary" onclick={onBrowseTimetable}>
				Browse the timetable
			</button>
		</div>
	{:else}
		{#each groups as group (group.date)}
			<div class="picks-day-header">
				<span>{group.label}</span>
				{#if group.date === todayDate}
					<span class="picks-today-badge">Today</span>
				{/if}
			</div>
			{#each group.performances as row (row.performance.id)}
				{@const performance = row.performance}
				{@const state = stateOf(performance.id)}
				{@const marks = marksOf(performance.id)}
				{@const src = thumbSrc(performance)}
				<div
					class="pick-item"
					class:pick-item-past={row.timing === 'past'}
					data-pick-id={performance.id}
					role="button"
					tabindex="0"
					onclick={() => onOpen(performance.id)}
					onkeydown={(event) => {
						if (event.key !== 'Enter' && event.key !== ' ') return;
						event.preventDefault(); // Space would otherwise scroll the page, as on a real button.
						onOpen(performance.id);
					}}
				>
					<span
						class="pick-thumb"
						style="background: hsl({artistThumbHue(performance.artist)}, 35%, 22%);"
					>
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
							<span class="pick-stage">{performance.stage}</span>
							{#if row.timing === 'now'}
								<span class="pick-pill pick-pill-now">Playing now</span>
							{:else if row.timing === 'soon'}
								<span class="pick-pill pick-pill-soon">Playing soon</span>
							{:else}
								<span class="pick-pill">{markLabel(state)}</span>
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

					{#if row.timing !== 'past'}
						{@const notifyOn = notificationsAvailable && notifyStateOf(performance.id)}
						{@const bell = notificationsAvailable
							? notifyOn
								? { label: 'Notifications on for this set — tap to mute', hint: 'Notifications on' }
								: { label: 'Notifications off for this set — tap to enable', hint: 'Notifications off' }
							: {
									label: 'Notifications are off for your account — tap to turn them on',
									hint: 'Notifications are off — tap to turn them on'
								}}
						<button
							type="button"
							class="pick-bell"
							class:pick-bell-on={notifyOn}
							class:pick-bell-muted={!notificationsAvailable}
							onclick={(event) => {
								event.stopPropagation();
								onToggleBell(performance.id);
							}}
							onkeydown={(event) => event.stopPropagation()}
							aria-label={bell.label}
							title={bell.hint}
						>
							<BellIcon filled={notifyOn} />
						</button>
					{/if}
				</div>
			{/each}
		{/each}
	{/if}
</div>

<style>
	.picks-view {
		flex: 1;
		overflow-y: auto;
		padding: 0 0.75rem 1rem;
	}

	.picks-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.85rem;
		margin-top: 3rem;
		padding: 0 1rem;
		text-align: center;
	}

	.picks-empty p {
		color: #888;
		font-size: 0.85rem;
		font-style: italic;
		margin: 0;
	}

	.picks-day-header {
		position: sticky;
		top: 0;
		z-index: 2;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.15rem;
		margin: 0 -0.75rem;
		padding-left: 0.75rem;
		background: #1c1c1c;
		border-bottom: 1px solid #2d2d2d;
		color: #bbb;
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.picks-today-badge {
		background: #3a6df0;
		color: #fff;
		border-radius: 999px;
		padding: 0.1em 0.55em;
		font-size: 0.6rem;
		letter-spacing: 0.02em;
	}

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

	.pick-bell {
		flex-shrink: 0;
		align-self: flex-start;
		margin-top: 0.1rem;
		width: 30px;
		height: 30px;
		border-radius: 50%;
		border: none;
		background: transparent;
		font-size: 1rem;
		line-height: 1;
		filter: grayscale(1);
		opacity: 0.45;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
	}

	.pick-bell-on {
		filter: none;
		opacity: 1;
	}

	.pick-bell-muted {
		filter: grayscale(1);
		opacity: 0.3;
	}

	@media (hover: hover) and (pointer: fine) {
		.pick-bell:hover {
			background: #2a2a2a;
		}
	}

	@media (max-width: 767px) {
		.picks-view {
			padding-bottom: 60px; /* Clears the mobile bottom bar. */
		}
	}
</style>
