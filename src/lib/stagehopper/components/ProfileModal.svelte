<script lang="ts">
	import { onMount } from 'svelte';
	import type { AttendeeProfile } from '../api.js';
	import { nicknameProblem } from '../profile.js';
	import { PARTICIPANT_COLORS } from '../selections.js';
	import Modal from './Modal.svelte';

	interface Props {
		/** The stored Profile; null while it has not loaded, which reads as empty. */
		profile: AttendeeProfile | null;
		/** Shown in red above the actions, e.g. when saving failed. */
		error?: string;
		/** Only the fields that changed; `{}` when nothing did. */
		onSave: (change: { nickname?: string; colour?: string }) => void | Promise<void>;
		onCancel: () => void;
	}

	const { profile, error = '', onSave, onCancel }: Props = $props();

	// The form is a draft over the Profile as it was when the modal opened.
	// svelte-ignore state_referenced_locally
	const stored = { nickname: profile?.nickname ?? '', colour: profile?.colour ?? null };
	let nickname = $state(stored.nickname);
	let colour = $state<string | null>(stored.colour);
	let problem = $state('');
	let saving = $state(false);
	let input: HTMLInputElement | undefined;

	onMount(() => input?.focus());

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const typed = nickname.trim();
		const change: { nickname?: string; colour?: string } = {};
		if (typed !== stored.nickname) {
			problem = nicknameProblem(typed);
			if (problem) return;
			change.nickname = typed;
		} else if (!typed) {
			problem = nicknameProblem(typed);
			return;
		}
		if (colour === null) {
			problem = 'Choose a colour.';
			return;
		}
		if (colour !== stored.colour) change.colour = colour;
		problem = '';
		saving = true;
		try {
			await onSave(change);
		} finally {
			saving = false;
		}
	}
</script>

{#snippet actions()}
	<button type="button" class="sh-btn sh-btn-secondary sh-btn-block" onclick={onCancel}>
		Cancel
	</button>
	<button
		type="submit"
		form="profile-form"
		class="sh-btn sh-btn-primary sh-btn-block"
		disabled={saving}
	>
		Save
	</button>
{/snippet}

<Modal
	title="Your profile"
	subtitle="Your Picks and Messages show your nickname and colour to everyone."
	error={problem || error}
	{actions}
>
	{#snippet children()}
		<form id="profile-form" onsubmit={submit} novalidate>
			<label class="field-label" for="profile-nickname">Nickname</label>
			<input
				id="profile-nickname"
				type="text"
				class="sh-input"
				bind:value={nickname}
				bind:this={input}
				maxlength="20"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
			/>

			<div class="field-label" id="profile-colour-label">Colour</div>
			<div class="colour-swatches" role="group" aria-labelledby="profile-colour-label">
				{#each PARTICIPANT_COLORS as option (option)}
					<button
						type="button"
						class="swatch"
						class:swatch-selected={colour === option}
						style="background: {option};"
						onclick={() => (colour = option)}
						aria-label="Colour {option}"
						aria-pressed={colour === option}
					></button>
				{/each}
			</div>
		</form>
	{/snippet}
</Modal>

<style>
	.field-label {
		display: block;
		margin: 0 0 0.35rem;
		font-size: 0.85rem;
		color: var(--sh-text-muted);
	}

	.colour-swatches {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.field-label + .colour-swatches {
		margin-bottom: 0;
	}

	input + .field-label {
		margin-top: 1rem;
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
