<script lang="ts">
	interface Props {
		/** Sync/save failure, shown in red. */
		error?: string;
		/** Explanatory hint, e.g. why the picks view is empty. */
		message?: string;
	}

	const { error = '', message = '' }: Props = $props();
</script>

{#if error || message}
	<div class="status-bar" role="status">
		{#if error}<span class="status-error">{error}</span>{/if}
		{#if message}<span class="status-msg">{message}</span>{/if}
	</div>
{/if}

<style>
	.status-bar {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0 0.75rem;
		min-height: 28px;
		background: #111;
		border-bottom: 1px solid #2d2d2d;
		flex-shrink: 0;
	}

	.status-error {
		font-size: 0.75rem;
		color: #e74c3c;
	}

	.status-msg {
		font-size: 0.75rem;
		color: #888;
		font-style: italic;
	}
</style>
