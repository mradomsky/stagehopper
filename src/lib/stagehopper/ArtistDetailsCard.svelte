<script>
	/** @typedef {{ id:string; name:string; image?:string } & Record<string, string|undefined>} ArtistLinkData */

	/** @type {{ id:string; artist:string; startTime:string; endTime:string; artistImage?:string; instagram?:string; artists?: ArtistLinkData[] }} */
	export let performance;
	/** @type {string} */
	export let stageName = '';
	/** @type {() => void} */
	export let onClose;

	const LINK_FIELDS = [
		{ key: 'instagram', label: 'Instagram' },
		{ key: 'spotify', label: 'Spotify' },
		{ key: 'website', label: 'Website' },
		{ key: 'youtube', label: 'YouTube' },
		{ key: 'facebook', label: 'Facebook' },
		{ key: 'tiktok', label: 'TikTok' },
		{ key: 'soundcloud', label: 'SoundCloud' },
		{ key: 'twitter', label: 'Twitter' }
	];

	$: firstArtist = performance?.artists?.[0] ?? null;
	$: image = firstArtist?.image ?? performance?.artistImage ?? null;
	$: links = firstArtist
		? LINK_FIELDS.filter((f) => firstArtist[f.key]).map((f) => ({ ...f, url: firstArtist[f.key] }))
		: performance?.instagram
			? [{ key: 'instagram', label: 'Instagram', url: performance.instagram }]
			: [];

	/** @param {MouseEvent} e */
	function handleBackdropClick(e) {
		if (e.target === e.currentTarget) onClose();
	}

	/** @param {KeyboardEvent} e */
	function handleKeydown(e) {
		if (e.key === 'Escape') onClose();
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
			<h2 class="details-name">{performance.artist}</h2>
			<p class="details-meta">
				{stageName}{stageName ? ' · ' : ''}{performance.startTime}–{performance.endTime}
			</p>

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
		box-sizing: border-box;
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

	.details-name {
		margin: 0 0 0.3rem;
		font-size: 1.3rem;
		color: #fffaf0;
	}

	.details-meta {
		margin: 0 0 1rem;
		color: #aaa;
		font-size: 0.85rem;
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
