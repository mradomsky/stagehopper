<script lang="ts">
	/**
	 * Sign-in, using Clerk's prebuilt component.
	 *
	 * It renders sign-in, sign-up and password reset as one flow. Sign-up is deliberately
	 * open: this is a room-sharing app for friends, and an invite-only instance breaks the
	 * product. The "Secured by Clerk" badge that comes with the prebuilt component is
	 * accepted rather than designed around.
	 *
	 * There is no `onCredential` callback. Clerk owns the flow end to end and the rest of
	 * the app learns about the new session from the store in `auth.svelte.ts`.
	 */
	import { onMount } from 'svelte';
	import Modal from './Modal.svelte';
	import { mountSignIn, unmountSignIn } from '../auth.svelte.js';

	interface Props {
		title: string;
		subtitle: string;
		/** Omit to render a modal the user cannot dismiss (e.g. an expired session). */
		onCancel?: () => void;
		/** Error raised by the caller, e.g. signing in with the wrong account. */
		error?: string;
	}

	const { title, subtitle, onCancel, error = '' }: Props = $props();

	let mountEl = $state<HTMLDivElement | null>(null);
	let initError = $state('');

	onMount(() => {
		const node = mountEl;
		if (!node) return;
		void mountSignIn(node).then((failure) => {
			initError = failure;
		});
		return () => unmountSignIn(node);
	});
</script>

{#snippet cancelAction()}
	<button type="button" class="sh-btn sh-btn-secondary" onclick={() => onCancel?.()}>Cancel</button>
{/snippet}

<Modal
	{title}
	{subtitle}
	error={error || initError}
	actions={onCancel ? cancelAction : undefined}
>
	{#snippet children()}
		<!--
			Purely a mount target: `mountSignIn` replaces this node with Clerk's own root, so
			styling it here would have no effect. Clerk sizes and themes its card itself, and
			removes that root again on unmount — reopening the modal renders exactly one.
		-->
		<div bind:this={mountEl}></div>
	{/snippet}
</Modal>
