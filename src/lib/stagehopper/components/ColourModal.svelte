<script lang="ts">
	import Modal from './Modal.svelte';
	import { PARTICIPANT_COLORS } from '../selections.js';

	interface Props {
		/** The current Colour, or null when none has been chosen yet. */
		selected: string | null;
		/** Shown in red above the actions, e.g. when saving failed. */
		error?: string;
		/** A swatch was tapped: the choice is saved at once. */
		onChoose: (colour: string) => void;
		onCancel: () => void;
	}

	const { selected, error = '', onChoose, onCancel }: Props = $props();
</script>

{#snippet actions()}
	<button type="button" class="sh-btn sh-btn-secondary sh-btn-block" onclick={onCancel}>
		Cancel
	</button>
{/snippet}

<Modal
	title="Choose your colour"
	subtitle="Your Picks show in this colour for everyone. Others may share it."
	{error}
	{actions}
>
	{#snippet children()}
		<div class="colour-swatches">
			{#each PARTICIPANT_COLORS as colour (colour)}
				<button
					type="button"
					class="swatch"
					class:swatch-selected={selected === colour}
					style="background: {colour};"
					onclick={() => onChoose(colour)}
					aria-label="Colour {colour}"
					aria-pressed={selected === colour}
				></button>
			{/each}
		</div>
	{/snippet}
</Modal>

<style>
	.colour-swatches {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.swatch {
		width: 36px;
		height: 36px;
		border-radius: 50%;
		border: 2px solid transparent;
		cursor: pointer;
		transition: border-color 0.1s;
	}

	.swatch:focus-visible {
		outline: 2px solid var(--sh-accent);
		outline-offset: 2px;
	}

	.swatch-selected {
		border-color: var(--sh-text);
	}

	@media (max-width: 767px) {
		.swatch {
			width: 44px;
			height: 44px;
		}
	}
</style>
