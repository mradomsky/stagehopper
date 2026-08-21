<script lang="ts">
	import type { LikedPerformance } from '../types.js';

	interface Props {
		performances: LikedPerformance[];
		onRemove: (performanceId: string) => void;
		onOpen: (performanceId: string) => void;
		onClose: () => void;
	}

	const { performances, onRemove, onOpen, onClose }: Props = $props();
</script>

<div class="liked-overlay">
	<div class="liked-header">
		<h2>Liked</h2>
		<button class="liked-close" onclick={onClose} aria-label="Close">✕</button>
	</div>

	<div class="liked-body">
		{#if performances.length === 0}
			<p class="liked-empty">Open a performance and tap ♥ to save it here.</p>
		{:else}
			{#each performances as performance (performance.id)}
				<div class="liked-item">
					<button type="button" class="liked-item-info" onclick={() => onOpen(performance.id)}>
						<div class="liked-item-artist">{performance.artist}</div>
						<div class="liked-item-meta">
							{performance.stage} · {performance.startTime}–{performance.endTime} · {performance.dayLabel}
						</div>
					</button>
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
</div>

<style>
	.liked-overlay {
		position: fixed;
		inset: 0;
		background: #121212;
		z-index: 55;
		display: flex;
		flex-direction: column;
		color: #fffaf0;
	}

	.liked-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 48px;
		padding: 0 0.75rem 0 1rem;
		background: #111;
		border-bottom: 1px solid #2d2d2d;
		flex-shrink: 0;
	}

	.liked-header h2 {
		margin: 0;
		font-size: 1rem;
		color: #fffaf0;
	}

	.liked-close {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		border: none;
		background: transparent;
		color: #ccc;
		font-size: 0.9rem;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}

	@media (hover: hover) and (pointer: fine) {
		.liked-close:hover {
			background: #2a2a2a;
			color: #fffaf0;
		}
	}

	.liked-body {
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
		flex: 1;
		min-width: 0;
		border: none;
		background: transparent;
		padding: 0;
		margin: 0;
		text-align: left;
		cursor: pointer;
		font: inherit;
		color: inherit;
	}

	@media (hover: hover) and (pointer: fine) {
		.liked-item-info:hover .liked-item-artist {
			color: #ffd27f;
		}
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
</style>
