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
		background: #111;
		border-bottom: 1px solid #2d2d2d;
		flex-shrink: 0;
	}

	.switch-pill {
		background: transparent;
		border: 1px solid #444;
		border-radius: 999px;
		color: #aaa;
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
			background: #1e1e1e;
			border-color: #666;
			color: #ddd;
		}
	}
</style>
