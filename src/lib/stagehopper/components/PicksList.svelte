<script lang="ts">
	import { tick } from 'svelte';
	import BellIcon from './BellIcon.svelte';
	import ScheduleDayHeader from './ScheduleDayHeader.svelte';
	import ScheduleRow from './ScheduleRow.svelte';
	import type { PickTiming } from '../picks.js';
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
		/** Stage name → admin-set colour. A stage with no entry uses the default neutral text. */
		stageColors?: Record<string, string>;
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
		stageColors,
		scrollTargetId,
		stateOf,
		marksOf,
		notifyStateOf,
		notificationsAvailable,
		onOpen,
		onToggleBell,
		onBrowseTimetable
	}: Props = $props();

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
			<ScheduleDayHeader date={group.date} label={group.label} today={group.date === todayDate} />
			{#each group.performances as row (row.performance.id)}
				{@const performance = row.performance}
				<ScheduleRow
					{performance}
					timing={row.timing}
					state={stateOf(performance.id)}
					marks={marksOf(performance.id)}
					stageColor={stageColors?.[performance.stage]}
					onOpen={() => onOpen(performance.id)}
				>
					{#snippet trailing()}
						{#if row.timing !== 'past'}
							{@const notifyOn = notificationsAvailable && notifyStateOf(performance.id)}
							{@const bell = notificationsAvailable
								? notifyOn
									? { label: 'Notifications on for this set — tap to mute', hint: 'Notifications on' }
									: {
											label: 'Notifications off for this set — tap to enable',
											hint: 'Notifications off'
										}
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
					{/snippet}
				</ScheduleRow>
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

	.pick-bell {
		flex-shrink: 0;
		align-self: flex-start;
		margin-top: -0.15rem;
		width: 38px;
		height: 38px;
		border-radius: 50%;
		border: none;
		background: transparent;
		font-size: 1.25rem;
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
		color: #ffd700;
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
