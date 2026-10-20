<script lang="ts">
	import { onMount } from 'svelte';
	import FestivalCard from '$lib/stagehopper/components/FestivalCard.svelte';
	import SignInModal from '$lib/stagehopper/components/SignInModal.svelte';
	import { checkAdmin, fetchFestivalSummary } from '$lib/stagehopper/api.js';
	import { AuthGate } from '$lib/stagehopper/auth-gate.svelte.js';
	import {
		auth,
		isAuthConfigured,
		loadAuth,
		signOut as endSession
	} from '$lib/stagehopper/auth.svelte.js';
	import { maybeOpenInstallPromo } from '$lib/stagehopper/install.js';
	import { compareFestivalsForLanding, FESTIVALS } from '$lib/stagehopper/festivals.svelte.js';
	import { isListed } from '$shared/festival-fields.js';
	import type { FestivalSummary } from '$lib/stagehopper/types.js';

	/**
	 * `undefined` while Clerk is still resolving the session. The header shows neither the
	 * name nor "Log in" until then, so a returning user never sees their name flash away —
	 * the same guarantee #96 added, now supplied by Clerk's own load rather than by
	 * validating a cached token.
	 */
	const authChecking = $derived(auth.user === undefined);
	let isAdmin = $state(false);

	/** festivalId → summary, filled per card as each request lands. A missing key is a bare card. */
	let summaries = $state<Record<string, FestivalSummary>>({});

	const gate = new AuthGate({ onSignedInIdle: handleSignedInIdle });

	// Clerk's prebuilt sign-in owns the flow end to end, so "the user signed in" arrives as
	// `auth.user` becoming set rather than as a callback.
	$effect(() => {
		if (gate.open && auth.user) gate.handleSignedIn();
	});

	const authEnabled = isAuthConfigured();

	// FESTIVALS is admin-editable data now, so its array order carries no meaning —
	// upcoming festivals (soonest first), then past ones (most recently finished first).
	// Unlisted festivals stay in FESTIVALS (rooms and browse ids still resolve them) but get no card.
	const sortedFestivals = $derived(FESTIVALS.filter(isListed).sort(compareFestivalsForLanding));

	/**
	 * One public request per listed Festival, all in parallel, each written to its own key as
	 * it lands: a slow or failed one leaves only its own card bare. A rejection is swallowed
	 * for the same reason.
	 * shortcut: one request per listed Festival, unbounded; batch endpoint when listed Festivals grow past ~20.
	 */
	const requested = new Set<string>();
	$effect(() => {
		// The list can arrive after mount (the manifest loads async), so ask for whatever is
		// listed now and not yet requested.
		for (const festival of sortedFestivals) {
			if (requested.has(festival.id)) continue;
			requested.add(festival.id);
			void fetchFestivalSummary(festival.id)
				.then((result) => {
					if (result.ok) summaries[festival.id] = result.data;
				})
				.catch(() => {});
		}
	});

	/**
	 * Ask the server whether this account may use the admin console.
	 *
	 * Cosmetic only: it decides whether the link is worth showing. Anyone can flip the flag
	 * in a debugger, which is why the gateway enforces the `admin` scope on every admin
	 * route regardless of what this returns.
	 */
	async function refreshAdminStatus() {
		if (!auth.user) return;
		isAdmin = await checkAdmin();
	}

	/** Plain "Log in" from the header — no queued action, just sign in. */
	function openLogin() {
		gate.promptLogin();
	}

	/** A fresh login with no queued action: offer the install promo and check admin status. */
	function handleSignedInIdle() {
		void refreshAdminStatus();
		maybeOpenInstallPromo();
	}

	async function signOut() {
		await endSession();
		isAdmin = false;
	}

	onMount(async () => {
		// Clerk resolves the session itself; `auth.user` stays `undefined` until it has, which
		// is what keeps the header quiet rather than flashing a name it may retract.
		await loadAuth();
		void refreshAdminStatus();
	});
</script>

<svelte:head>
	<meta name="description" content="StageHopper – plan festivals with your friends." />
	<title>StageHopper</title>
</svelte:head>

{#if gate.open}
	<SignInModal title="Sign in to continue" onCancel={() => gate.cancel()} />
{/if}

<div class="page">
	<header class="hero">
		<div class="hero-top">
			<div class="brand">
				<span class="logo">🎵</span>
				<span class="brand-name">StageHopper</span>
			</div>
			{#if authChecking}
				<span class="spinner auth-spinner" aria-label="Checking sign-in" role="status"></span>
			{:else if auth.user}
				<p class="auth-status">
					{#if isAdmin}
						<a class="link-btn" href="/admin">Admin</a> ·
					{/if}
					{auth.user.name} ·
					<button type="button" class="link-btn" onclick={() => void signOut()}>Sign out</button>
				</p>
			{:else if authEnabled}
				<button type="button" class="link-btn login-btn" onclick={openLogin}>Log in</button>
			{/if}
		</div>
		<h1>Plan your festival days, together.</h1>
		<p class="tagline">
			Browse the lineup, mark your must-sees, and see what your friends are going to — live.
		</p>
	</header>

	<main class="content">
		<section class="section">
			<h2 class="section-title">Festivals</h2>
			<div class="festival-grid">
				{#each sortedFestivals as festival (festival.id)}
					<FestivalCard {festival} summary={summaries[festival.id]} />
				{/each}
			</div>
		</section>

	</main>
</div>

<style>
	.page {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}

	.hero {
		padding: 2rem 1.5rem 2.5rem;
		background:
			radial-gradient(ellipse at top, var(--sh-accent-glow), transparent 60%),
			var(--sh-bg);
		border-bottom: 1px solid var(--sh-border-subtle);
	}

	.hero-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		max-width: 960px;
		margin: 0 auto 1.5rem;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.logo {
		font-size: 1.6rem;
	}

	.brand-name {
		font-size: 1.1rem;
		font-weight: 700;
		color: var(--sh-text);
	}

	.auth-status {
		font-size: 0.85rem;
		color: var(--sh-text-muted);
		margin: 0;
		white-space: nowrap;
	}

	/* Quiet placeholder in the auth slot while the cached login is being validated. */
	.auth-spinner {
		display: inline-block;
	}

	.link-btn {
		background: none;
		border: none;
		padding: 0;
		color: var(--sh-accent);
		font-size: inherit;
		cursor: pointer;
		text-decoration: underline;
	}

	/* Sign-in affordance: a solid brand-color pill that opens Clerk's hosted form. */
	.login-btn {
		padding: 0.6rem 1.5rem;
		border: 1px solid var(--sh-accent);
		border-radius: 999px;
		background: var(--sh-accent);
		color: var(--sh-on-accent);
		font-size: 0.95rem;
		font-weight: 600;
		text-decoration: none;
		white-space: nowrap;
		transition:
			background 0.12s,
			border-color 0.12s;
	}

	.login-btn:hover {
		background: var(--sh-accent-hover);
		border-color: var(--sh-accent-hover);
	}

	.hero h1 {
		max-width: 960px;
		margin: 0 auto 0.5rem;
		font-size: 2rem;
		color: var(--sh-text);
	}

	.tagline {
		max-width: 960px;
		margin: 0 auto;
		font-size: 1rem;
		color: var(--sh-text-soft);
		line-height: 1.6;
	}

	.content {
		flex: 1;
		width: 100%;
		max-width: 960px;
		margin: 0 auto;
		padding: 2rem 1.5rem 3rem;
	}

	.section {
		margin-bottom: 2.5rem;
	}

	.section-title {
		font-size: 1rem;
		font-weight: 600;
		color: var(--sh-text-strong);
		margin: 0 0 1rem;
	}

	.spinner {
		width: 16px;
		height: 16px;
		border: 2px solid var(--sh-border);
		border-top-color: var(--sh-accent);
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.festival-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 1.25rem;
	}

	@media (max-width: 767px) {
		.hero {
			padding: 1.5rem 1.25rem 2rem;
		}

		.hero h1 {
			font-size: 1.5rem;
		}

		.tagline {
			font-size: 0.9rem;
		}

		.content {
			padding: 1.5rem 1.25rem 2.5rem;
		}

		.festival-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
