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

<div class="signin-backdrop" role="dialog" aria-modal="true" aria-label={title}>
	<div class="signin-context">
		<h2>{title}</h2>
		<p>{subtitle}</p>
	</div>

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

	{#if onCancel}
		<button type="button" class="signin-cancel" onclick={() => onCancel?.()}>Cancel</button>
	{/if}
</div>

<style>
	.signin-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.75);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		z-index: 50;
		padding: 1rem;
		overflow-y: auto;
	}

	.signin-context {
		text-align: center;
		max-width: 380px;
	}

	.signin-context h2 {
		margin: 0 0 0.3rem;
		font-size: 1.1rem;
		color: #fffaf0;
	}

	.signin-context p {
		margin: 0;
		color: #aaa;
		font-size: 0.85rem;
		line-height: 1.4;
	}

	.signin-cancel {
		background: transparent;
		border: none;
		color: #ccc;
		font-size: 0.85rem;
		cursor: pointer;
		text-decoration: underline;
	}

	.signin-cancel:hover {
		color: #fff;
	}
</style>
