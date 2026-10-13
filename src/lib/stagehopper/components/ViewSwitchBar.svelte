<script lang="ts">
	import type { TimetableLayout } from '../types.js';

	interface Props {
		layout: TimetableLayout;
		onToggle: () => void;
	}

	const { layout, onToggle }: Props = $props();

	// The pill names where it takes you, not where you are.
	const label = $derived(layout === 'grid' ? '☰ Switch to list view' : '⊞ Switch to grid view');
</script>

<div class="switch-bar">
	<button type="button" class="switch-pill" onclick={onToggle} aria-label={label} title={label}>
		{label}
	</button>
</div>

<style>
	.switch-bar {
		display: flex;
		align-items: center;
		padding: 0 0.75rem;
		height: 34px;
		background: var(--sh-bg-deep);
		border-bottom: 1px solid var(--sh-border-subtle);
		flex-shrink: 0;
	}

	.switch-pill {
		background: transparent;
		border: 1px solid var(--sh-border);
		border-radius: 999px;
		color: var(--sh-text-muted);
		padding: 0.18rem 0.7rem;
		font: inherit;
		font-size: 0.7rem;
		white-space: nowrap;
		cursor: pointer;
		transition:
			background 0.12s,
			border-color 0.12s,
			color 0.12s;
	}

	@media (hover: hover) and (pointer: fine) {
		.switch-pill:hover {
			background: var(--sh-surface-low);
			border-color: var(--sh-border-strong);
			color: var(--sh-text-strong);
		}
	}
</style>
