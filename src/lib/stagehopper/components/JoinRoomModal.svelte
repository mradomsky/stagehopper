<script lang="ts">
	import Modal from './Modal.svelte';
	import { PARTICIPANT_COLORS } from '../selections.js';

	interface Props {
		/** Name typed so far; bound so the parent owns the value. */
		name: string;
		selectedColor: string;
		/** Colours already claimed by other participants in this room. */
		takenColors: ReadonlySet<string>;
		onSelectColor: (color: string) => void;
		onConfirm: () => void;
	}

	let {
		name = $bindable(),
		selectedColor,
		takenColors,
		onSelectColor,
		onConfirm
	}: Props = $props();

	const canConfirm = $derived(name.trim().length > 0);
</script>

{#snippet confirmAction()}
	<button
		type="button"
		class="sh-btn sh-btn-primary sh-btn-block"
		onclick={onConfirm}
		disabled={!canConfirm}
	>
		Join room
	</button>
{/snippet}

<Modal
	title="Join the room"
	subtitle="Enter your name and pick a colour so friends can identify your picks."
	actions={confirmAction}
>
	{#snippet children()}
		<label class="modal-label" for="join-name">Your name</label>
		<input
			id="join-name"
			type="text"
			class="sh-input"
			bind:value={name}
			maxlength="50"
			placeholder="e.g. Alex"
			onkeydown={(event) => event.key === 'Enter' && canConfirm && onConfirm()}
		/>

		<fieldset class="color-fieldset">
			<legend class="modal-label">Your colour</legend>
			<div class="color-swatches">
				{#each PARTICIPANT_COLORS as color (color)}
					{@const taken = takenColors.has(color)}
					<button
						type="button"
						class="swatch"
						class:swatch-selected={selectedColor === color}
						class:swatch-taken={taken}
						style="background: {color};"
						onclick={() => onSelectColor(color)}
						disabled={taken}
						aria-label="Colour {color}{taken ? ' (taken)' : ''}"
					></button>
				{/each}
			</div>
		</fieldset>
	{/snippet}
</Modal>

<style>
	.modal-label {
		display: block;
		font-size: 0.8rem;
		color: #ccc;
		margin-bottom: 0.4rem;
	}

	.color-fieldset {
		border: 0;
		padding: 0;
		margin: 1rem 0 0;
		min-width: 0;
	}

	.color-swatches {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.swatch {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		border: 2px solid transparent;
		cursor: pointer;
		transition: border-color 0.1s;
	}

	.swatch-selected {
		border-color: #fff;
	}

	.swatch-taken {
		opacity: 0.25;
		cursor: not-allowed;
	}

	@media (max-width: 767px) {
		.modal-label {
			font-size: 0.75rem;
			margin-bottom: 0.3rem;
		}

		.color-swatches {
			gap: 0.4rem;
		}

		.swatch {
			width: 32px;
			height: 32px;
		}
	}

	@media (max-width: 479px) {
		.swatch {
			width: 28px;
			height: 28px;
		}
	}
</style>
