<script lang="ts">
	import { onMount } from 'svelte';
	import {
		getGoogleClientId,
		googleSignInErrorMessage,
		initGoogleSignIn,
		type GoogleCredentialResponse
	} from '../google-identity.js';

	interface Props {
		onCredential: (response: GoogleCredentialResponse) => void;
		/** Reports a failure to load or initialize Google Identity Services. */
		onError?: (message: string) => void;
	}

	const { onCredential, onError }: Props = $props();

	let buttonEl = $state<HTMLDivElement | null>(null);

	onMount(() => {
		void initGoogleSignIn({ clientId: getGoogleClientId(), onCredential, buttonEl }).then(
			(failure) => {
				if (failure) onError?.(googleSignInErrorMessage(failure));
			}
		);
	});
</script>

<div class="sh-google-button" bind:this={buttonEl}></div>
