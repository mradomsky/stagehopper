<script lang="ts">
	import { festivalPath } from '../festivals.svelte.js';
	import type { Festival } from '../types.js';

	interface Props {
		festival: Festival;
	}

	const { festival }: Props = $props();

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
	</div>
</a>

<style>
	.festival-card {
		display: block;
		border: 1px solid #2e2e2e;
		border-radius: 14px;
		overflow: hidden;
		background: #1e1e1e;
		text-decoration: none;
		color: inherit;
		transition:
			transform 0.15s,
			border-color 0.15s;
	}

	.festival-card:hover {
		border-color: #444;
		transform: translateY(-2px);
	}

	.festival-cover {
		position: relative;
		height: 180px;
		display: flex;
		align-items: center;
		justify-content: center;
		/* Neutral placeholder shown until/unless a cover image loads. */
		background: #2a2a2a;
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
		color: #fff;
		backdrop-filter: blur(2px);
	}

	/* Base state for a non-past festival: "Upcoming" — yellow. */
	.festival-badge-live {
		background: rgba(241, 196, 15, 0.9);
		color: #000;
	}

	/* Overrides the above when the festival is live now: "Happening now" — green. */
	.festival-badge-happening {
		background: rgba(46, 204, 113, 0.85);
		color: #fff;
	}

	.festival-body {
		padding: 1rem;
	}

	.festival-name {
		font-weight: 600;
		font-size: 0.95rem;
		color: #fffaf0;
	}

	.festival-subtitle {
		font-size: 0.8rem;
		color: #aaa;
		margin-top: 0.3rem;
	}
</style>
