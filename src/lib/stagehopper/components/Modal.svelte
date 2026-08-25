<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		/** Optional explanatory line under the title. */
		subtitle?: string;
		/** Message shown in red above the actions. */
		error?: string;
		children: Snippet;
		/** Buttons rendered in a row at the bottom of the card. */
		actions?: Snippet;
	}

	const { title, subtitle = '', error = '', children, actions }: Props = $props();
</script>

<div class="modal-backdrop">
	<div class="modal-card" role="dialog" aria-modal="true" aria-label={title}>
		<h2>{title}</h2>
		{#if subtitle}
			<p class="modal-sub">{subtitle}</p>
		{/if}

		{@render children()}

		{#if error}
			<p class="sh-error">{error}</p>
		{/if}

		{#if actions}
			<div class="dialog-actions">
				{@render actions()}
			</div>
		{/if}
	</div>
</div>

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.75);
		display: flex;
		align-items: center;
		justify-content: center;
		/* Above the artist/performance details card (z-index 60): NotificationsModal opens
		   from a button inside that card and must land in front of it, not behind. */
		z-index: 65;
		padding: 1rem;
	}

	.modal-card {
		background: #232323;
		border: 1px solid #444;
		border-radius: 12px;
		padding: 2rem;
		max-width: 380px;
		width: 100%;
		text-align: left;
	}

	h2 {
		margin: 0 0 0.4rem;
		font-size: 1.3rem;
		color: #fffaf0;
	}

	.modal-sub {
		color: #aaa;
		font-size: 0.85rem;
		margin: 0 0 1.5rem;
		line-height: 1.5;
	}

	.dialog-actions {
		display: flex;
		gap: 0.6rem;
		margin-top: 1.5rem;
	}

	.dialog-actions :global(> *) {
		flex: 1;
	}

	@media (max-width: 767px) {
		.modal-backdrop {
			padding: 0.5rem;
		}

		.modal-card {
			padding: 1.5rem;
			border-radius: 8px;
		}

		h2 {
			font-size: 1.1rem;
			margin-bottom: 0.5rem;
		}

		.modal-sub {
			font-size: 0.8rem;
			margin-bottom: 1rem;
		}
	}

	@media (max-width: 479px) {
		.modal-card {
			padding: 1.25rem;
		}

		h2 {
			font-size: 1rem;
		}

		.modal-sub {
			font-size: 0.75rem;
		}
	}
</style>
