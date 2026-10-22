<script lang="ts">
	import { festivalPath } from '../festivals.svelte.js';
	import type { Festival, FestivalSummary } from '../types.js';

	interface Props {
		festival: Festival;
		/** Landing-card summary; absent or failed to load renders the card without it. */
		summary?: FestivalSummary;
	}

	const { festival, summary }: Props = $props();

	/** Reset whenever the festival itself changes, not just its imageUrl. */
	let imageFailed = $state(false);
	$effect(() => {
		void festival.id;
		imageFailed = false;
	});
</script>

<a class="festival-card" href={festivalPath(festival.id)}>
	<div class="festival-cover">
		{#if festival.imageUrl && !imageFailed}
			<img class="festival-cover-blur" src={festival.imageUrl} alt="" aria-hidden="true" />
			<img
				class="festival-cover-image"
				src={festival.imageUrl}
				alt=""
				onerror={() => (imageFailed = true)}
			/>
		{/if}
		<span
			class="festival-badge"
			class:festival-badge-live={!festival.past}
			class:festival-badge-happening={festival.happeningNow}
		>
			{#if festival.past}
				Past
			{:else if festival.happeningNow}
				Happening now
			{:else}
				Upcoming
			{/if}
		</span>
	</div>
	<div class="festival-body">
		<div class="festival-name">{festival.name}</div>
		<div class="festival-subtitle">{festival.subtitle}</div>
		{#if summary && summary.attendees > 0}
			<div class="festival-attending">{summary.attendees} attending</div>
			{#if summary.latestMessage}
				<div class="festival-latest">
					{summary.latestMessage.nickname}: {summary.latestMessage.text}
				</div>
			{/if}
		{/if}
	</div>
</a>

<style>
	.festival-card {
		display: block;
		border: 1px solid var(--sh-border-subtle);
		border-radius: 14px;
		overflow: hidden;
		background: var(--sh-surface-low);
		text-decoration: none;
		color: inherit;
		transition:
			transform 0.15s,
			border-color 0.15s;
	}

	.festival-card:hover {
		border-color: var(--sh-border);
		transform: translateY(-2px);
	}

	.festival-cover {
		position: relative;
		height: 180px;
		display: flex;
		align-items: center;
		justify-content: center;
		/* Neutral placeholder shown until/unless a cover image loads. */
		background: var(--sh-surface);
	}

	/* Full image, never cropped; letterbox space is filled by the blurred layer below. */
	.festival-cover-image {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: contain;
		z-index: 1;
	}

	/* A scaled, blurred copy of the same image fills whatever the contained image leaves. */
	.festival-cover-blur {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		filter: blur(16px) saturate(1.2);
		transform: scale(1.2);
		z-index: 0;
	}

	.festival-badge {
		position: absolute;
		top: 0.6rem;
		right: 0.6rem;
		z-index: 2;
		font-size: 0.7rem;
		font-weight: 600;
		padding: 0.2rem 0.55rem;
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.45);
		color: var(--sh-fixed-white);
		backdrop-filter: blur(2px);
	}

	/* Base state for a non-past festival: "Upcoming" — yellow. */
	.festival-badge-live {
		background: var(--sh-badge-upcoming);
		color: var(--sh-fixed-black);
	}

	/* Overrides the above when the festival is live now: "Happening now" — green. */
	.festival-badge-happening {
		background: var(--sh-badge-happening);
		color: var(--sh-fixed-white);
	}

	.festival-body {
		padding: 1rem;
	}

	.festival-name {
		font-weight: 600;
		font-size: 0.95rem;
		color: var(--sh-text);
	}

	.festival-subtitle {
		font-size: 0.8rem;
		color: var(--sh-text-muted);
		margin-top: 0.3rem;
	}

	.festival-attending {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--sh-text-strong);
		margin-top: 0.6rem;
	}

	/* One line, ellipsis on overflow, so a long Message never widens the card. */
	.festival-latest {
		font-size: 0.8rem;
		color: var(--sh-text-muted);
		margin-top: 0.2rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
