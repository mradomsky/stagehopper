<script lang="ts">
	interface Props {
		/** ISO date, exposed as `data-day-date` so the list's scroll-spy can find it. */
		date: string;
		label: string;
		/** Whether this is the festival day currently in progress. */
		today: boolean;
	}

	const { date, label, today }: Props = $props();
</script>

<div class="day-header" data-day-date={date}>
	<span>{label}</span>
	{#if today}
		<span class="today-badge">Today</span>
	{/if}
</div>

<style>
	.day-header {
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

	.today-badge {
		background: #3a6df0;
		color: #fff;
		border-radius: 999px;
		padding: 0.1em 0.55em;
		font-size: 0.6rem;
		letter-spacing: 0.02em;
	}
</style>
