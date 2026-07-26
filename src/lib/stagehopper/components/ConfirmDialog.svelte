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
		onConfirm,
		onCancel
	}: Props = $props();
</script>

<Modal {title} {subtitle} {error}>
	{#snippet children()}{/snippet}
	{#snippet actions()}
		<button type="button" class="sh-btn sh-btn-secondary" onclick={onCancel} disabled={busy}>
			{cancelLabel}
		</button>
		<button type="button" class="sh-btn sh-btn-primary" onclick={onConfirm} disabled={busy}>
			{busy && busyLabel ? busyLabel : confirmLabel}
		</button>
	{/snippet}
</Modal>
