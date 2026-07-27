<script lang="ts">
	import type { LikedPerformance } from '../types.js';

	interface Props {
		performances: LikedPerformance[];
		onRemove: (performanceId: string) => void;
	}

	const { performances, onRemove }: Props = $props();
</script>

<div class="liked-view">
	{#if performances.length === 0}
		<p class="liked-empty">Open a performance and tap ♥ to save it here.</p>
	{:else}
		{#each performances as performance (performance.id)}
			<div class="liked-item">
				<div class="liked-item-info">
					<div class="liked-item-artist">{performance.artist}</div>
					<div class="liked-item-meta">
						{performance.stage} · {performance.startTime}–{performance.endTime} · {performance.dayLabel}
					</div>
				</div>
				<button
					type="button"
					class="liked-item-remove"
					onclick={() => onRemove(performance.id)}
					aria-label="Remove {performance.artist} from liked"
				>
					✕
				</button>
			</div>
		{/each}
	{/if}
</div>

<style>
	.liked-view {
		flex: 1;
		overflow-y: auto;
		padding: 1rem 0.75rem;
	}

	.liked-empty {
		color: #666;
		font-size: 0.85rem;
		font-style: italic;
		text-align: center;
		margin-top: 2rem;
	}

	.liked-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.65rem 0;
		border-bottom: 1px solid #2a2a2a;
	}

	.liked-item-info {
		min-width: 0;
	}

	.liked-item-artist {
		font-size: 0.9rem;
		font-weight: 600;
		color: #fffaf0;
	}

	.liked-item-meta {
		font-size: 0.75rem;
		color: #777;
		margin-top: 0.15rem;
	}

	.liked-item-remove {
		flex-shrink: 0;
		width: 30px;
		height: 30px;
		border-radius: 50%;
		border: none;
		background: transparent;
		color: #777;
		font-size: 0.9rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		transition:
			color 0.1s,
			background 0.1s;
	}

	@media (hover: hover) and (pointer: fine) {
		.liked-item-remove:hover {
			color: #e74c3c;
			background: #2a2a2a;
		}
	}

	@media (max-width: 767px) {
		.liked-view {
			padding-bottom: 60px; /* Clears the mobile bottom bar. */
		}
	}
</style>
