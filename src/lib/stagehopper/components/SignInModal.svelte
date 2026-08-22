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
	import { mountSignIn, unmountSignIn } from '../auth.svelte.js';

	interface Props {
		/** Not shown — Clerk's own header covers it. Kept as the dialog's aria-label. */
		title: string;
		/** Omit to render a modal the user cannot dismiss (e.g. an expired session). */
		onCancel?: () => void;
		/** Error raised by the caller, e.g. signing in with the wrong account. */
		error?: string;
	}

	const { title, onCancel, error = '' }: Props = $props();

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

	function handleBackdropClick(event: MouseEvent) {
		if (event.target === event.currentTarget) onCancel?.();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') onCancel?.();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="signin-backdrop" onclick={handleBackdropClick} role="presentation">
	<div class="signin-shell" role="dialog" aria-modal="true" aria-label={title}>
		{#if onCancel}
			<button type="button" class="signin-close" onclick={() => onCancel?.()} aria-label="Close">
				✕
			</button>
		{/if}

		<!--
			Purely a mount target: `mountSignIn` replaces this node with Clerk's own root, so
			styling it here would have no effect. Clerk sizes and themes its own card (dark, to
			match the app — see the appearance passed to `clerk.load` in auth.svelte.ts), and
			removes that root again on unmount — reopening the modal renders exactly one.
		-->
		<div bind:this={mountEl}></div>

		{#if error || initError}
			<p class="sh-error">{error || initError}</p>
		{/if}
	</div>
</div>

<style>
	.signin-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.75);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 50;
		padding: 1rem;
		overflow-y: auto;
	}

	.signin-shell {
		position: relative;
		width: 100%;
		max-width: 400px;
	}

	.signin-close {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		border: none;
		background: rgba(0, 0, 0, 0.5);
		color: #fffaf0;
		font-size: 0.9rem;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		z-index: 1;
	}

	.signin-close:hover {
		background: rgba(0, 0, 0, 0.7);
	}
</style>
