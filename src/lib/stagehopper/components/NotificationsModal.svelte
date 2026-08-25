<script lang="ts">
	import { onMount } from 'svelte';
	import Modal from './Modal.svelte';
	import {
		pushSupported,
		getPermission,
		requestPermission,
		subscribe,
		getExistingSubscription,
		unsubscribeLocal
	} from '../push.js';
	import type { PushSubscriptionJSON } from '../push.js';
	import {
		getNotificationSettings,
		saveNotificationSettings,
		addPushSubscription,
		removePushSubscription,
		type NotificationSettings
	} from '../api.js';
	import { loadPushEndpoint, savePushEndpoint, clearPushEndpoint } from '../storage.js';
	import { detectInstallContext, IOS_INSTALL_INSTRUCTION, installPromoOpen } from '../install.js';

	interface Props {
		onClose: () => void;
		/**
		 * Reports settings this popup just loaded or saved, so a caller caching them
		 * elsewhere (the Picks tab's bells) stays in sync. Omit if nothing else needs them.
		 */
		onSettingsChange?: (settings: Partial<NotificationSettings>) => void;
	}

	const { onClose, onSettingsChange }: Props = $props();

	/** Lead-time presets offered in the popup; the server validates against the same set. */
	const LEAD_OPTIONS = [5, 10, 15, 20, 30];
	/** Public VAPID key, injected at build time (safe to ship). */
	const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY ?? '';

	const supported = pushSupported();
	// When push isn't available, the right advice depends on the device (see install.ts):
	// iOS users must install via Safari; other browsers simply can't do web push here.
	const installContext = detectInstallContext();
	let permission = $state(getPermission());
	let loading = $state(true);
	/** True when there is no usable session — notifications key on the signed-in user. */
	let signedOut = $state(false);
	/** Whether push is active on *this* device (a subscription exists here). */
	let enabledHere = $state(false);
	let leadMinutes = $state(15);
	let notifyMaybe = $state(false);
	// The last values known to be stored server-side. The two above are a working draft:
	// edits stay local until the user confirms them, so a half-made change is never
	// persisted and a failed save can't leave the popup disagreeing with the database.
	let savedLead = $state(15);
	let savedMaybe = $state(false);
	let error = $state('');
	let busy = $state(false);

	const dirty = $derived(leadMinutes !== savedLead || notifyMaybe !== savedMaybe);

	onMount(load);

	async function load() {
		if (!supported) {
			loading = false;
			return;
		}
		const existing = await getExistingSubscription();
		const res = await getNotificationSettings(existing?.endpoint);
		if (res.ok) {
			leadMinutes = savedLead = res.data.leadMinutes;
			notifyMaybe = savedMaybe = res.data.notifyMaybe;
			onSettingsChange?.(res.data);
			// A live browser subscription is the truth for "this device is on" — not whether
			// the server happens to list this exact endpoint. iOS can rotate the endpoint (or a
			// past registration can have failed), leaving a live subscription the server doesn't
			// know about; keying off subscribedHere alone then wrongly reads "off", the user
			// re-enables, and the old row is orphaned. Trust the browser and reconcile the
			// server to it.
			enabledHere = !!existing;
			if (existing && !res.data.subscribedHere) {
				await registerDevice(existing);
			}
		} else if (res.unauthorized) {
			signedOut = true;
		} else {
			error = 'Could not load your notification settings.';
		}
		loading = false;
	}

	/**
	 * Register this device's subscription and drop the endpoint it replaces, so a rotated
	 * endpoint never leaves a duplicate server row behind. The replaced endpoint is remembered
	 * across sessions in local storage; removing it is best-effort (a stale one just no-ops).
	 */
	async function registerDevice(sub: PushSubscriptionJSON) {
		const previous = loadPushEndpoint();
		if (previous && previous !== sub.endpoint) {
			await removePushSubscription(previous);
		}
		const res = await addPushSubscription(sub);
		if (res.ok) savePushEndpoint(sub.endpoint);
		return res;
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
		const res = await registerDevice(sub);
		if (res.ok) {
			enabledHere = true;
			// The account-wide `enabled` flag flips true the moment any device registers —
			// bells shouldn't stay muted until the dialog happens to reload.
			onSettingsChange?.({ enabled: true });
		} else if (res.unauthorized) signedOut = true;
		else error = 'Could not enable notifications.';
		busy = false;
	}

	/**
	 * Turn off push on this device only (per-device subscription). Doesn't report
	 * `enabled: false` upstream — the account can still have other devices subscribed,
	 * and only the server knows for sure; the cache catches up on the next full fetch.
	 */
	async function deactivate() {
		error = '';
		busy = true;
		const endpoint = await unsubscribeLocal();
		if (endpoint) await removePushSubscription(endpoint);
		clearPushEndpoint();
		enabledHere = false;
		busy = false;
	}

	/**
	 * Persist the draft preferences (global to the user, across devices) and, on success,
	 * adopt them as the new baseline — which is what clears the confirm button.
	 */
	async function persist() {
		const res = await saveNotificationSettings({ leadMinutes, notifyMaybe });
		if (res.ok) {
			savedLead = leadMinutes;
			savedMaybe = notifyMaybe;
			onSettingsChange?.(res.data);
		} else if (res.unauthorized) {
			signedOut = true;
		} else {
			// Previously swallowed: the popup would show the new value while the database
			// kept the old one, with nothing to tell the user which had won.
			error = 'Could not save your notification settings.';
		}
	}

	/** Commit the staged edits. Closing without pressing this simply discards them. */
	async function confirmChanges() {
		error = '';
		busy = true;
		await persist();
		busy = false;
	}

	function selectLead(value: number) {
		leadMinutes = value;
	}

	function toggleMaybe() {
		notifyMaybe = !notifyMaybe;
	}

	/** Explicit ask from this dialog, so it bypasses the once-per-device promo gating. */
	function openInstallPromo() {
		installPromoOpen.set(true);
		onClose();
	}
</script>

<Modal title="Notifications" {error}>
	{#if !supported}
		{#if installContext.platform === 'ios' && !installContext.isStandalone}
			<p class="note">{IOS_INSTALL_INSTRUCTION} Then reopen this from the installed app.</p>
			<button class="primary" onclick={openInstallPromo}>Install</button>
		{:else}
			<p class="note">Notifications aren't available in this browser.</p>
		{/if}
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
				<span>Send notifications for "maybe going" events</span>
				<input type="checkbox" checked={notifyMaybe} onchange={toggleMaybe} />
			</label>

			{#if dirty}
				<button class="primary confirm" onclick={confirmChanges} disabled={busy}>
					{busy ? 'Saving…' : 'Confirm changes'}
				</button>
			{/if}

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

	.confirm {
		margin-top: 1rem;
	}

	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
