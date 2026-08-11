<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import ConfirmDialog from '$lib/stagehopper/components/ConfirmDialog.svelte';
	import FestivalCard from '$lib/stagehopper/components/FestivalCard.svelte';
	import GoogleSignInModal from '$lib/stagehopper/components/GoogleSignInModal.svelte';
	import MyRoomsList from '$lib/stagehopper/components/MyRoomsList.svelte';
	import { checkAdmin, createRoom, leaveRoom, listMyRooms } from '$lib/stagehopper/api.js';
	import { ensureFreshGoogleAuth } from '$lib/stagehopper/auth.js';
	import { maybeOpenInstallPromo } from '$lib/stagehopper/install.js';
	import { compareFestivalsForLanding, FESTIVALS } from '$lib/stagehopper/festivals.svelte.js';
	import {
		getGoogleClientId,
		parseGoogleIdTokenClaims,
		type GoogleCredentialResponse
	} from '$lib/stagehopper/google-identity.js';
	import { generateRoomId, parseRoomIdInput, roomPath } from '$lib/stagehopper/rooms.js';
	import { clearGoogleAuth, loadGoogleAuth, saveGoogleAuth } from '$lib/stagehopper/storage.js';
	import type { GoogleIdentity, RoomMembership } from '$lib/stagehopper/types.js';

	/** What the visitor asked for before we knew they were signed out. */
	type PendingAction = { type: 'create'; festivalId: string } | { type: 'join' };

	let auth = $state<GoogleIdentity | null>(null);
	let isAdmin = $state(false);
	let myRooms = $state<RoomMembership[]>([]);
	/** True while the room list is being fetched, so the section can show a spinner. */
	let roomsLoading = $state(false);
	let googleAuthError = $state('');
	let errorMsg = $state('');

	let creatingFestivalId = $state<string | null>(null);
	let joinValue = $state('');
	let joinError = $state('');
	let joining = $state(false);

	let leaveTargetRoomId = $state<string | null>(null);
	let leavingRoom = $state(false);
	let leaveError = $state('');

	let pendingAction = $state<PendingAction | null>(null);
	let signinGateOpen = $state(false);

	const googleAuthEnabled = getGoogleClientId().length > 0;

	// FESTIVALS is admin-editable data now, so its array order carries no meaning —
	// upcoming festivals (soonest first), then past ones (most recently finished first).
	const sortedFestivals = $derived([...FESTIVALS].sort(compareFestivalsForLanding));

	async function loadMyRooms() {
		if (!auth) return;
		roomsLoading = true;
		// The cached token may have expired while the app was backgrounded; refresh it
		// first, or the request 401s and the list silently stays empty (#reopen bug).
		const fresh = await ensureFreshGoogleAuth();
		auth = fresh;
		if (!fresh) {
			roomsLoading = false;
			return;
		}
		const result = await listMyRooms(fresh.idToken);
		// Non-fatal — the join/create flow works without this list.
		if (result.ok) myRooms = result.data;
		roomsLoading = false;
	}

	/**
	 * Ask the server whether this account may use the admin console.
	 *
	 * Cosmetic only: it decides whether the link is worth showing. Anyone can flip the
	 * flag in a debugger, which is why the Lambda re-checks on every admin route.
	 */
	async function refreshAdminStatus() {
		if (!auth) return;
		// Same expiry trap as loadMyRooms: a stale token makes checkAdmin read false and
		// the admin link vanishes even though the account is still an admin.
		const fresh = await ensureFreshGoogleAuth();
		auth = fresh;
		if (!fresh) return;
		isAdmin = await checkAdmin(fresh.idToken);
	}

	/** Redirect to the room named by `?next`, if present and the user is signed in. */
	function redirectToNextIfPresent(): boolean {
		if (!auth) return false;
		const rawNext = page.url.searchParams.get('next');
		const nextRoomId = rawNext ? parseRoomIdInput(rawNext) : null;
		if (!nextRoomId) return false;
		void goto(roomPath(nextRoomId), { replaceState: true });
		return true;
	}

	async function doCreateRoom(festivalId: string) {
		creatingFestivalId = festivalId;
		errorMsg = '';

		const festival = FESTIVALS.find((f) => f.id === festivalId);
		if (!festival) {
			errorMsg = 'Could not create room. Please try again.';
			creatingFestivalId = null;
			return;
		}

		const roomId = generateRoomId(festival.prefix);
		const result = await createRoom(roomId);
		if (!result.ok) {
			errorMsg = 'Could not create room. Please try again.';
			creatingFestivalId = null;
			return;
		}
		void goto(roomPath(roomId));
	}

	function openSigninGate(action: PendingAction) {
		pendingAction = action;
		googleAuthError = '';
		signinGateOpen = true;
	}

	/** Plain "Log in" from the header — no queued action, just sign in. */
	function openLogin() {
		pendingAction = null;
		googleAuthError = '';
		signinGateOpen = true;
	}

	function createRoomFor(festivalId: string) {
		if (!auth) {
			openSigninGate({ type: 'create', festivalId });
			return;
		}
		void doCreateRoom(festivalId);
	}

	function joinRoom() {
		joinError = '';
		const roomId = parseRoomIdInput(joinValue);
		if (!roomId) {
			joinError = 'Enter a room code, link, or name.';
			return;
		}
		if (!auth) {
			openSigninGate({ type: 'join' });
			return;
		}
		joining = true;
		void goto(roomPath(roomId));
	}

	function handleCredential(response: GoogleCredentialResponse) {
		const idToken = response?.credential ?? '';
		const claims = parseGoogleIdTokenClaims(idToken);
		if (!idToken || !claims) {
			googleAuthError = 'Google sign-in failed. Please try again.';
			return;
		}

		const identity: GoogleIdentity = {
			idToken,
			sub: claims.sub,
			name: claims.name,
			givenName: claims.givenName
		};
		saveGoogleAuth(identity);
		auth = identity;
		googleAuthError = '';
		signinGateOpen = false;

		const action = pendingAction;
		pendingAction = null;
		if (action?.type === 'create') {
			void doCreateRoom(action.festivalId);
			return;
		}
		if (action?.type === 'join') {
			joinRoom();
			return;
		}
		if (!redirectToNextIfPresent()) {
			void loadMyRooms();
			void refreshAdminStatus();
			// Plain "Log in" with no queued action and no room to jump to — this is the one
			// fresh-login site with no name/color step, so offer the install promo right here.
			// The create/join paths navigate into a room, where confirmJoin fires it instead.
			maybeOpenInstallPromo();
		}
	}

	function signOut() {
		clearGoogleAuth();
		auth = null;
		isAdmin = false;
		myRooms = [];
	}

	async function confirmLeaveRoom() {
		if (!auth || !leaveTargetRoomId) return;
		const fresh = await ensureFreshGoogleAuth();
		auth = fresh;
		if (!fresh) {
			leaveError = 'Your session expired. Sign in again.';
			return;
		}
		const roomId = leaveTargetRoomId;
		leavingRoom = true;
		leaveError = '';

		const result = await leaveRoom(roomId, fresh.idToken);
		if (!result.ok) {
			leaveError = 'Could not leave the room. Please try again.';
			leavingRoom = false;
			return;
		}

		myRooms = myRooms.filter((room) => room.roomId !== roomId);
		leavingRoom = false;
		leaveTargetRoomId = null;
	}

	onMount(() => {
		auth = loadGoogleAuth();
		if (!redirectToNextIfPresent()) {
			void loadMyRooms();
			void refreshAdminStatus();
		}
	});
</script>

<svelte:head>
	<meta name="description" content="StageHopper – plan festivals with your friends." />
	<title>StageHopper</title>
</svelte:head>

{#if leaveTargetRoomId}
	<ConfirmDialog
		title="Leave this room?"
		subtitle="Your picks in it will be deleted."
		error={leaveError}
		confirmLabel="Leave room"
		busyLabel="Leaving…"
		busy={leavingRoom}
		onConfirm={() => void confirmLeaveRoom()}
		onCancel={() => {
			leaveTargetRoomId = null;
			leaveError = '';
		}}
	/>
{/if}

{#if signinGateOpen}
	<GoogleSignInModal
		title="Sign in to continue"
		subtitle={pendingAction
			? `Sign in with Google to ${pendingAction.type === 'join' ? 'join' : 'create'} a room.`
			: 'Sign in with Google to save your picks across devices.'}
		error={googleAuthError}
		onCredential={handleCredential}
		onCancel={() => {
			signinGateOpen = false;
			pendingAction = null;
		}}
	/>
{/if}

<div class="page">
	<header class="hero">
		<div class="hero-top">
			<div class="brand">
				<span class="logo">🎵</span>
				<span class="brand-name">StageHopper</span>
			</div>
			{#if auth}
				<p class="auth-status">
					{#if isAdmin}
						<a class="link-btn" href="/admin">Admin</a> ·
					{/if}
					{auth.name} · <button type="button" class="link-btn" onclick={signOut}>Sign out</button>
				</p>
			{:else if googleAuthEnabled}
				<button type="button" class="link-btn login-btn" onclick={openLogin}>Log in</button>
			{/if}
		</div>
		<h1>Plan your festival days, together.</h1>
		<p class="tagline">
			Browse the lineup, mark your must-sees, and see what your friends are going to — live.
		</p>
		{#if googleAuthError}
			<p class="sh-error">{googleAuthError}</p>
		{/if}
	</header>

	<main class="content">
		{#if auth}
			<section class="section">
				<h2 class="section-title">Your rooms</h2>
				{#if roomsLoading}
					<div class="rooms-status" role="status" aria-live="polite">
						<span class="spinner" aria-hidden="true"></span>
						<span>Loading your rooms…</span>
					</div>
				{:else if myRooms.length > 0}
					<MyRoomsList
						rooms={myRooms}
						onOpen={(roomId) => void goto(roomPath(roomId))}
						onLeave={(roomId) => {
							leaveError = '';
							leaveTargetRoomId = roomId;
						}}
					/>
				{:else}
					<p class="rooms-status">You have no rooms yet.</p>
				{/if}
			</section>
		{/if}

		<section class="section">
			<h2 class="section-title">Festivals</h2>
			<div class="festival-grid">
				{#each sortedFestivals as festival (festival.id)}
					<FestivalCard
						{festival}
						creating={creatingFestivalId === festival.id}
						disabled={creatingFestivalId !== null}
						onCreateRoom={() => createRoomFor(festival.id)}
					/>
				{/each}
			</div>
			{#if errorMsg}
				<p class="sh-error">{errorMsg}</p>
			{/if}
		</section>

		<section class="section">
			<h2 class="section-title">Have a room code?</h2>
			<div class="join-row">
				<input
					type="text"
					class="sh-input join-input"
					placeholder="Room code, link, or name"
					bind:value={joinValue}
					onkeydown={(event) => {
						if (event.key === 'Enter') joinRoom();
					}}
				/>
				<button
					type="button"
					class="sh-btn sh-btn-secondary"
					onclick={joinRoom}
					disabled={!joinValue.trim() || joining}
				>
					Join
				</button>
			</div>
			{#if joinError}
				<p class="sh-error">{joinError}</p>
			{/if}
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
			radial-gradient(ellipse at top, rgba(231, 76, 60, 0.16), transparent 60%),
			#181818;
		border-bottom: 1px solid #2a2a2a;
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
		color: #fffaf0;
	}

	.auth-status {
		font-size: 0.85rem;
		color: #aaa;
		margin: 0;
		white-space: nowrap;
	}

	.link-btn {
		background: none;
		border: none;
		padding: 0;
		color: #e74c3c;
		font-size: inherit;
		cursor: pointer;
		text-decoration: underline;
	}

	/* Minimalistic sign-in affordance: a quiet pill, not Google's rendered button. */
	.login-btn {
		padding: 0.35rem 0.9rem;
		border: 1px solid #444;
		border-radius: 999px;
		color: #fffaf0;
		font-size: 0.85rem;
		text-decoration: none;
		white-space: nowrap;
		transition:
			border-color 0.12s,
			color 0.12s;
	}

	.login-btn:hover {
		border-color: #e74c3c;
	}

	.hero h1 {
		max-width: 960px;
		margin: 0 auto 0.5rem;
		font-size: 2rem;
		color: #fffaf0;
	}

	.tagline {
		max-width: 960px;
		margin: 0 auto;
		font-size: 1rem;
		color: #ccc;
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
		color: #ddd;
		margin: 0 0 1rem;
	}

	.rooms-status {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin: 0;
		color: #999;
		font-size: 0.9rem;
	}

	.spinner {
		width: 16px;
		height: 16px;
		border: 2px solid #444;
		border-top-color: #e74c3c;
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

	.join-row {
		display: flex;
		gap: 0.5rem;
	}

	.join-input {
		flex: 1;
		min-width: 0;
		padding: 0.7rem 0.9rem;
		border-radius: 8px;
		border-color: #444;
		background: rgba(20, 20, 20, 0.8);
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

		.join-row {
			flex-direction: column;
		}
	}
</style>
