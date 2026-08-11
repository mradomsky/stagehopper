<script lang="ts">
	import { onMount } from 'svelte';
	import Modal from './Modal.svelte';
	import { ensureFreshGoogleAuth } from '../auth.js';
	import {
		pushSupported,
		getPermission,
		requestPermission,
		subscribe,
		getExistingSubscription,
		unsubscribeLocal
	} from '../push.js';
	import {
		getNotificationSettings,
		saveNotificationSettings,
		addPushSubscription,
		removePushSubscription
	} from '../api.js';

	interface Props {
		onClose: () => void;
	}

	const { onClose }: Props = $props();

	/** Lead-time presets offered in the popup; the server validates against the same set. */
	const LEAD_OPTIONS = [5, 10, 15, 20, 30];
	/** Public VAPID key, injected at build time (safe to ship). */
	const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY ?? '';

	const supported = pushSupported();
	let permission = $state(getPermission());
	let loading = $state(true);
	/** True when the user has no usable Google identity — notifications key on it. */
	let signedOut = $state(false);
	/** Whether push is active on *this* device (a subscription exists here). */
	let enabledHere = $state(false);
	let leadMinutes = $state(15);
	let notifyAttending = $state(false);
	let notifyMaybe = $state(false);
	let error = $state('');
	let busy = $state(false);

	onMount(load);

	async function load() {
		if (!supported) {
			loading = false;
			return;
		}
		const id = await ensureFreshGoogleAuth();
		if (!id) {
			signedOut = true;
			loading = false;
			return;
		}
		const existing = await getExistingSubscription();
		const res = await getNotificationSettings(id.idToken, existing?.endpoint);
		if (res.ok) {
			leadMinutes = res.data.leadMinutes;
			notifyAttending = res.data.notifyAttending;
			notifyMaybe = res.data.notifyMaybe;
			enabledHere = res.data.subscribedHere;
		} else if (res.unauthorized) {
			signedOut = true;
		} else {
			error = 'Could not load your notification settings.';
		}
		loading = false;
	}

	/** Enable push on this device: permission → subscribe → register the subscription. */
	async function activate() {
		error = '';
		busy = true;
		permission = await requestPermission();
		if (permission !== 'granted') {
			busy = false;
			return;
		}
		const sub = await subscribe(vapidKey);
		if (!sub) {
			error = 'Could not enable notifications on this device.';
			busy = false;
			return;
		}
		const id = await ensureFreshGoogleAuth();
		if (!id) {
			signedOut = true;
			busy = false;
			return;
		}
		const res = await addPushSubscription(id.idToken, sub);
		if (res.ok) {
			enabledHere = true;
			// Enabling a device with no category on would deliver nothing — the notifier
			// only fires when a mark matches an enabled category. Default "Going" on so the
			// switch does something; leave existing prefs alone on re-enable.
			if (!notifyAttending && !notifyMaybe) {
				notifyAttending = true;
				await saveSettings();
			}
		} else if (res.unauthorized) signedOut = true;
		else error = 'Could not enable notifications.';
		busy = false;
	}

	/** Turn off push on this device only (per-device subscription). */
	async function deactivate() {
		error = '';
		busy = true;
		const endpoint = await unsubscribeLocal();
		const id = await ensureFreshGoogleAuth();
		if (id && endpoint) await removePushSubscription(id.idToken, endpoint);
		enabledHere = false;
		busy = false;
	}

	/** Persist the category/lead preferences (global to the user, across devices). */
	async function saveSettings() {
		const id = await ensureFreshGoogleAuth();
		if (!id) {
			signedOut = true;
			return;
		}
		const res = await saveNotificationSettings(id.idToken, {
			leadMinutes,
			notifyAttending,
			notifyMaybe
		});
		if (!res.ok && res.unauthorized) signedOut = true;
	}

	function selectLead(value: number) {
		leadMinutes = value;
		void saveSettings();
	}

	function toggleAttending() {
		notifyAttending = !notifyAttending;
		void saveSettings();
	}

	function toggleMaybe() {
		notifyMaybe = !notifyMaybe;
		void saveSettings();
	}
</script>

<Modal title="Notifications" {error}>
	{#if !supported}
		<p class="note">
			Notifications aren't available in this browser. On iPhone, add StageHopper to your Home
			Screen first, then reopen this from the installed app.
		</p>
	{:else if signedOut}
		<p class="note">Sign in to enable notifications.</p>
	{:else if loading}
		<p class="note">Loading…</p>
	{:else}
		{#if !enabledHere}
			{#if permission === 'denied'}
				<p class="note">
					Notifications are blocked in your browser settings. Allow them for this site, then try
					again.
				</p>
			{/if}
			<button class="primary" onclick={activate} disabled={busy || permission === 'denied'}>
				Turn on for this device
			</button>
			<p class="hint">Get a reminder before sets you're going to.</p>
		{:else}
			<div class="section">
				<span class="section-label">Remind me before a set</span>
				<div class="presets">
					{#each LEAD_OPTIONS as opt (opt)}
						<button
							class="preset"
							class:preset-active={leadMinutes === opt}
							onclick={() => selectLead(opt)}
						>
							{opt}m
						</button>
					{/each}
				</div>
			</div>

			<label class="switch-row">
				<span>Notify for "Going"</span>
				<input type="checkbox" checked={notifyAttending} onchange={toggleAttending} />
			</label>
			<label class="switch-row">
				<span>Notify for "Maybe"</span>
				<input type="checkbox" checked={notifyMaybe} onchange={toggleMaybe} />
			</label>

			<button class="secondary" onclick={deactivate} disabled={busy}>
				Turn off for this device
			</button>
		{/if}
	{/if}

	{#snippet actions()}
		<button type="button" class="sh-btn sh-btn-secondary" onclick={onClose}>Close</button>
	{/snippet}
</Modal>

<style>
	.note,
	.hint {
		color: #aaa;
		font-size: 0.85rem;
		line-height: 1.5;
		margin: 0 0 1rem;
	}

	.hint {
		margin: 0.6rem 0 0;
		font-size: 0.8rem;
	}

	.section {
		margin-bottom: 1.1rem;
	}

	.section-label {
		display: block;
		color: #ddd;
		font-size: 0.85rem;
		margin-bottom: 0.5rem;
	}

	.presets {
		display: flex;
		gap: 0.4rem;
	}

	.preset {
		flex: 1;
		background: transparent;
		border: 1px solid #444;
		border-radius: 6px;
		color: #ccc;
		padding: 0.5rem 0;
		font-size: 0.8rem;
		cursor: pointer;
	}

	.preset-active {
		background: #3a6df0;
		border-color: #3a6df0;
		color: #fff;
	}

	.switch-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.55rem 0;
		border-top: 1px solid #333;
		color: #eee;
		font-size: 0.9rem;
	}

	.switch-row input {
		width: 1.1rem;
		height: 1.1rem;
	}

	.primary,
	.secondary {
		width: 100%;
		border-radius: 8px;
		padding: 0.7rem;
		font-size: 0.9rem;
		cursor: pointer;
		border: 1px solid #444;
	}

	.primary {
		background: #3a6df0;
		border-color: #3a6df0;
		color: #fff;
	}

	.secondary {
		background: transparent;
		color: #ccc;
		margin-top: 1rem;
	}

	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
