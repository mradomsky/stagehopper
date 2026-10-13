<script lang="ts">
	interface Props {
		/** Sync/save failure, shown in red. */
		error?: string;
	}

	const { error = '' }: Props = $props();
</script>

{#if error}
	<div class="status-bar" role="status">
		<span class="status-error">{error}</span>
	</div>
{/if}

<style>
	.status-bar {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0 0.75rem;
		min-height: 28px;
		background: var(--sh-bg-deep);
		border-bottom: 1px solid var(--sh-border-subtle);
		flex-shrink: 0;
	}

	.status-error {
		font-size: 0.75rem;
		color: var(--sh-error);
	}
</style>
