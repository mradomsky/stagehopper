<script lang="ts">
	import { onMount } from 'svelte';
	import Modal from './Modal.svelte';
	import {
		getGoogleClientId,
		googleSignInErrorMessage,
		initGoogleSignIn,
		type GoogleCredentialResponse
	} from '../google-identity.js';

	interface Props {
		title: string;
		subtitle: string;
		/** Called with the Google credential once the user completes sign-in. */
		onCredential: (response: GoogleCredentialResponse) => void;
		/** Omit to render a modal the user cannot dismiss (e.g. an expired session). */
		onCancel?: () => void;
		/** Error raised by the caller, e.g. signing in with the wrong account. */
		error?: string;
	}

	const { title, subtitle, onCredential, onCancel, error = '' }: Props = $props();

	let buttonEl = $state<HTMLDivElement | null>(null);
	let initError = $state('');

	onMount(() => {
		void initGoogleSignIn({
			clientId: getGoogleClientId(),
			onCredential,
			buttonEl
		}).then((failure) => {
			initError = googleSignInErrorMessage(failure);
		});
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
		<div class="sh-google-button" bind:this={buttonEl}></div>
	{/snippet}
</Modal>
