<script lang="ts">
	import Modal from './Modal.svelte';

	interface Props {
		title: string;
		subtitle?: string;
		error?: string;
		confirmLabel: string;
		/** Replaces the confirm label while the action is in flight. */
		busyLabel?: string;
		busy?: boolean;
		cancelLabel?: string;
		/**
		 * When set, the confirm button stays disabled until the user types this exact string.
		 * The last guard against a destructive misclick on an irreversible action.
		 */
		confirmText?: string;
		onConfirm: () => void;
		onCancel: () => void;
	}

	const {
		title,
		subtitle = '',
		error = '',
		confirmLabel,
		busyLabel = '',
		busy = false,
		cancelLabel = 'Cancel',
		confirmText = '',
		onConfirm,
		onCancel
	}: Props = $props();

	let typed = $state('');
	const matched = $derived(!confirmText || typed === confirmText);
</script>

<Modal {title} {subtitle} {error}>
	{#snippet children()}
		{#if confirmText}
			<label class="confirm-label" for="confirm-input">
				Type <code>{confirmText}</code> to confirm
			</label>
			<input
				id="confirm-input"
				type="text"
				class="sh-input"
				bind:value={typed}
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				disabled={busy}
			/>
		{/if}
	{/snippet}
	{#snippet actions()}
		<button type="button" class="sh-btn sh-btn-secondary" onclick={onCancel} disabled={busy}>
			{cancelLabel}
		</button>
		<button
			type="button"
			class="sh-btn sh-btn-primary"
			onclick={onConfirm}
			disabled={busy || !matched}
		>
			{busy && busyLabel ? busyLabel : confirmLabel}
		</button>
	{/snippet}
</Modal>

<style>
	.confirm-label {
		display: block;
		font-size: 0.8rem;
		color: #ccc;
		margin: 0 0 0.4rem;
	}

	.confirm-label code {
		color: #fffaf0;
	}
</style>
