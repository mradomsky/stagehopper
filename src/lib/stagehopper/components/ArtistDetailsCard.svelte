<script lang="ts">
	import type { Artist, Performance } from '../types.js';

	interface Props {
		performance: Performance;
		stageName?: string;
		/** Whether this performance is on the viewer's liked list. */
		liked?: boolean;
		/** Omit to hide the like control (e.g. nothing to save it to). */
		onToggleLike?: () => void;
		onClose: () => void;
	}

	const { performance, stageName = '', liked = false, onToggleLike, onClose }: Props = $props();

	/** Social links, in the order they are offered. */
	const LINK_FIELDS = [
		{ key: 'instagram', label: 'Instagram' },
		{ key: 'spotify', label: 'Spotify' },
		{ key: 'website', label: 'Website' },
		{ key: 'youtube', label: 'YouTube' },
		{ key: 'facebook', label: 'Facebook' },
		{ key: 'tiktok', label: 'TikTok' },
		{ key: 'soundcloud', label: 'SoundCloud' },
		{ key: 'twitter', label: 'Twitter' }
	] as const satisfies ReadonlyArray<{ key: keyof Artist; label: string }>;

	const firstArtist = $derived(performance.artists?.[0] ?? null);
	const image = $derived(firstArtist?.image ?? performance.artistImage ?? null);

	const links = $derived.by(() => {
		if (firstArtist) {
			return LINK_FIELDS.filter((field) => firstArtist[field.key]).map((field) => ({
				key: field.key,
				label: field.label,
				url: String(firstArtist[field.key])
			}));
		}
		if (performance.instagram) {
			return [{ key: 'instagram', label: 'Instagram', url: performance.instagram }];
		}
		return [];
	});

	function handleBackdropClick(event: MouseEvent) {
		if (event.target === event.currentTarget) onClose();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') onClose();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="details-backdrop" onclick={handleBackdropClick} role="presentation">
	<div class="details-card" role="dialog" aria-modal="true" aria-label={performance.artist}>
		<button class="details-close" onclick={onClose} aria-label="Close">✕</button>

		{#if image}
			<img class="details-photo" src={image} alt={performance.artist} />
		{:else}
			<div class="details-photo details-photo-placeholder" aria-hidden="true">🎤</div>
		{/if}

		<div class="details-body">
			<div class="details-heading">
				<div class="details-heading-text">
					<h2 class="details-name">{performance.artist}</h2>
					<p class="details-meta">
						{stageName}{stageName ? ' · ' : ''}{performance.startTime}–{performance.endTime}
					</p>
				</div>
				{#if onToggleLike}
					<button
						class="details-like"
						class:details-like-on={liked}
						onclick={onToggleLike}
						aria-pressed={liked}
						aria-label={liked ? 'Remove from liked' : 'Add to liked'}
						title={liked ? 'Remove from liked' : 'Add to liked'}
					>
						{liked ? '♥' : '♡'}
					</button>
				{/if}
			</div>

			{#if links.length > 0}
				<div class="details-links">
					{#each links as link (link.key)}
						<a class="details-link" href={link.url} target="_blank" rel="noopener noreferrer">
							{link.label}
						</a>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.details-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.75);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 60;
		padding: 1rem;
	}

	.details-card {
		position: relative;
		background: #232323;
		border: 1px solid #444;
		border-radius: 12px;
		max-width: 420px;
		width: 100%;
		max-height: 85vh;
		overflow-y: auto;
	}

	.details-close {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		border: none;
		background: rgba(0, 0, 0, 0.5);
		color: #fffaf0;
		font-size: 0.9rem;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		z-index: 1;
	}

	.details-photo {
		display: block;
		width: 100%;
		height: 220px;
		object-fit: cover;
		border-radius: 12px 12px 0 0;
	}

	.details-photo-placeholder {
		background: linear-gradient(135deg, #3a3a3a, #1a1a1a);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 3rem;
	}

	.details-body {
		padding: 1.25rem 1.5rem 1.5rem;
	}

	.details-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.details-heading-text {
		min-width: 0;
	}

	.details-name {
		margin: 0 0 0.3rem;
		font-size: 1.3rem;
		color: #fffaf0;
	}

	.details-meta {
		margin: 0;
		color: #aaa;
		font-size: 0.85rem;
	}

	.details-like {
		flex-shrink: 0;
		width: 44px;
		height: 44px;
		border-radius: 50%;
		border: 1px solid #444;
		background: #2c2c2c;
		color: #888;
		font-size: 1.35rem;
		line-height: 1;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition:
			color 0.12s,
			border-color 0.12s;
	}

	.details-like-on {
		color: #e74c3c;
		border-color: #e74c3c;
	}

	@media (hover: hover) and (pointer: fine) {
		.details-like:hover {
			color: #e74c3c;
			border-color: #e74c3c;
		}
	}

	.details-links {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.details-link {
		border: 1px solid #555;
		border-radius: 999px;
		padding: 0.35rem 0.85rem;
		font-size: 0.75rem;
		color: #fffaf0;
		text-decoration: none;
		background: #2c2c2c;
	}

	.details-link:hover {
		border-color: #e74c3c;
	}

	@media (max-width: 767px) {
		.details-backdrop {
			align-items: flex-end;
			padding: 0;
		}

		.details-card {
			max-width: none;
			max-height: 85vh;
			border-radius: 16px 16px 0 0;
			animation: details-slide-up 0.22s ease-out;
		}

		.details-photo {
			border-radius: 16px 16px 0 0;
		}
	}

	@keyframes details-slide-up {
		from {
			transform: translateY(100%);
		}
		to {
			transform: translateY(0);
		}
	}
</style>
