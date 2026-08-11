<script lang="ts">
	import Modal from './Modal.svelte';
	import {
		detectInstallContext,
		triggerNativeInstall,
		canNativeInstall,
		markInstallPromoSeen,
		installPromoOpen
	} from '../install.js';

	/** Apple's own "Add to Home Screen" help, opened in a new tab from the iOS steps. */
	const APPLE_SUPPORT_URL = 'https://support.apple.com/en-gb/guide/iphone/iphea86e5236/ios';

	const ctx = detectInstallContext();
	/** iOS shows steps only after the user asks for them, keeping the first view uncluttered. */
	let showIosSteps = $state(false);
	let installing = $state(false);

	function dismiss() {
		markInstallPromoSeen();
		installPromoOpen.set(false);
	}

	async function androidInstall() {
		installing = true;
		await triggerNativeInstall();
		installing = false;
		// Whether accepted or dismissed, this device has had its one shot.
		dismiss();
	}
</script>

<Modal title="Add StageHopper to your phone">
	<ul class="benefits">
		<li>Stay signed in — no logging in again each visit</li>
		<li>Set reminders — get notified before acts you're going to</li>
		<li>One tap — launch full-screen from your home screen</li>
	</ul>

	{#if ctx.platform === 'ios'}
		{#if showIosSteps}
			<ol class="steps">
				<li>
					<span class="glyph" aria-hidden="true">
						<!-- iOS Share: a box with an up-arrow rising out of it. -->
						<svg viewBox="0 0 24 24" width="22" height="22">
							<path
								d="M12 3l3.5 3.5M12 3L8.5 6.5M12 3v12"
								fill="none"
								stroke="currentColor"
								stroke-width="1.8"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
							<path
								d="M6 10.5H5A1.5 1.5 0 003.5 12v7A1.5 1.5 0 005 20.5h14a1.5 1.5 0 001.5-1.5v-7A1.5 1.5 0 0019 10.5h-1"
								fill="none"
								stroke="currentColor"
								stroke-width="1.8"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
					</span>
					<span>Tap <strong>Share</strong></span>
				</li>
				<li>
					<span class="glyph" aria-hidden="true">
						<!-- Add to Home Screen: a plus inside a rounded square. -->
						<svg viewBox="0 0 24 24" width="22" height="22">
							<rect
								x="3.5"
								y="3.5"
								width="17"
								height="17"
								rx="4"
								fill="none"
								stroke="currentColor"
								stroke-width="1.8"
							/>
							<path
								d="M12 8v8M8 12h8"
								fill="none"
								stroke="currentColor"
								stroke-width="1.8"
								stroke-linecap="round"
							/>
						</svg>
					</span>
					<span>Tap <strong>Add to Home Screen</strong></span>
				</li>
			</ol>
			<p class="hint">
				<a href={APPLE_SUPPORT_URL} target="_blank" rel="noopener">Apple Support page</a>
			</p>
		{:else}
			<button class="primary" onclick={() => (showIosSteps = true)}>Install</button>
		{/if}
	{:else if $canNativeInstall}
		<button class="primary" onclick={androidInstall} disabled={installing}>
			{installing ? 'Installing…' : 'Install'}
		</button>
	{:else}
		<p class="hint">Tap your browser menu (⋮) → <strong>Add to Home screen</strong>.</p>
	{/if}

	{#snippet actions()}
		<button type="button" class="sh-btn sh-btn-secondary" onclick={dismiss}>
			{ctx.platform === 'android' && $canNativeInstall ? 'Not now' : 'Got it'}
		</button>
	{/snippet}
</Modal>

<style>
	.benefits {
		list-style: none;
		margin: 0 0 1.25rem;
		padding: 0;
	}

	.benefits li {
		position: relative;
		padding: 0.35rem 0 0.35rem 1.4rem;
		color: #eee;
		font-size: 0.9rem;
		line-height: 1.4;
	}

	.benefits li::before {
		content: '✓';
		position: absolute;
		left: 0;
		color: #3a6df0;
		font-weight: 700;
	}

	.steps {
		list-style: none;
		margin: 0 0 1rem;
		padding: 0;
		counter-reset: step;
	}

	.steps li {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		padding: 0.5rem 0;
		border-top: 1px solid #333;
		color: #eee;
		font-size: 0.9rem;
	}

	.glyph {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 34px;
		height: 34px;
		flex-shrink: 0;
		border: 1px solid #444;
		border-radius: 8px;
		color: #cbd6ff;
	}

	.steps strong {
		color: #fffaf0;
	}

	.hint {
		color: #aaa;
		font-size: 0.85rem;
		line-height: 1.5;
		margin: 0.75rem 0 0;
	}

	.hint a {
		color: #3a6df0;
	}

	.primary {
		width: 100%;
		border-radius: 8px;
		padding: 0.7rem;
		font-size: 0.9rem;
		cursor: pointer;
		border: 1px solid #3a6df0;
		background: #3a6df0;
		color: #fff;
	}

	.primary:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
