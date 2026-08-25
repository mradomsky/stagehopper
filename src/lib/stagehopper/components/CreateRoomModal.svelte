<script lang="ts">
	import Modal from './Modal.svelte';
	import { MAX_ROOM_DISPLAY_NAME_LENGTH } from '../rooms.js';

	interface Props {
		/** Room name typed so far; bound so the parent owns the value. */
		roomName: string;
		/** Validation message for the typed name, or null when it's fine to submit. */
		nameError: string | null;
		/** True while the create request is in flight. */
		creating: boolean;
		/** Set after a failed create request. */
		error?: string;
		onConfirm: () => void;
		onCancel: () => void;
	}

	let {
		roomName = $bindable(),
		nameError,
		creating,
		error = '',
		onConfirm,
		onCancel
	}: Props = $props();
</script>

<Modal title="Create a room" {error}>
	{#snippet children()}
		<label class="modal-label" for="room-name">Room name (optional)</label>
		<input
			id="room-name"
			type="text"
			class="sh-input"
			maxlength={MAX_ROOM_DISPLAY_NAME_LENGTH}
			bind:value={roomName}
			disabled={creating}
			onkeydown={(event) => event.key === 'Enter' && !nameError && onConfirm()}
		/>
		{#if nameError}
			<p class="sh-error">{nameError}</p>
		{/if}
	{/snippet}
	{#snippet actions()}
		<button type="button" class="sh-btn sh-btn-secondary" onclick={onCancel} disabled={creating}>
			Cancel
		</button>
		<button
			type="button"
			class="sh-btn sh-btn-primary"
			onclick={onConfirm}
			disabled={creating || !!nameError}
		>
			{creating ? 'Creating…' : 'Create room'}
		</button>
	{/snippet}
</Modal>

<style>
	.modal-label {
		display: block;
		font-size: 0.8rem;
		color: #ccc;
		margin-bottom: 0.4rem;
	}
</style>
