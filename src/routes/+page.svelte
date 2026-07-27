<script>
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { FESTIVALS, getFestivalByPrefix } from '$lib/stagehopper/festivals.js';
	import { generateRoomId, parseRoomIdInput } from '$lib/stagehopper/utils.js';
	import {
		getGoogleAccountsApi,
		loadGoogleScript,
		parseGoogleIdTokenClaims
	} from '$lib/stagehopper/google-identity.js';
	import { clearGoogleAuth, loadGoogleAuth, saveGoogleAuth } from '$lib/stagehopper/auth-storage.js';

	/** @type {string | null} */
	let creatingFestivalId = null;
	let errorMsg = '';

	/** @type {{ idToken: string; sub: string; name: string; givenName: string } | null} */
	let auth = null;
	let googleAuthEnabled = false;
	let googleAuthError = '';
	/** @type {HTMLDivElement | null} */
	let googleButtonEl = null;

	let joinValue = '';
	let joinError = '';
	let joining = false;

	/** @type {Array<{roomId:string; name:string; color:string; updatedAt:number}>} */
	let myRooms = [];

	/** @type {string | null} */
	let leaveTargetRoomId = null;
	let leavingRoom = false;
	let leaveError = '';

	/** @type {{ type: 'create'; festivalId: string } | { type: 'join' } | null} */
	let pendingLandingAction = null;
	let signinGateOpen = false;
	/** @type {HTMLDivElement | null} */
	let signinGateButtonEl = null;

	/** @param {string} rid */
	function roomLabel(rid) {
		const festival = getFestivalByPrefix(rid);
		return festival ? festival.name : rid;
	}

	/** @param {string} rid */
	function roomIsPast(rid) {
		return getFestivalByPrefix(rid)?.past ?? false;
	}

	async function loadMyRooms() {
		if (!auth) return;
		try {
			const resp = await fetch('/api/stagehopper/users/me/rooms', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ googleIdToken: auth.idToken })
			});
			if (!resp.ok) return;
			myRooms = await resp.json();
		} catch {
			// Non-fatal — the join/create flow works without this list.
		}
	}

	/** @param {string} rid */
	function requestLeaveRoom(rid) {
		leaveError = '';
		leaveTargetRoomId = rid;
	}

	function cancelLeaveRoom() {
		leaveTargetRoomId = null;
		leaveError = '';
	}

	async function confirmLeaveRoom() {
		if (!auth || !leaveTargetRoomId) return;
		const rid = leaveTargetRoomId;
		leavingRoom = true;
		leaveError = '';
		try {
			const resp = await fetch(`/api/stagehopper/rooms/${encodeURIComponent(rid)}/selections`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ googleIdToken: auth.idToken })
			});
			if (!resp.ok) {
				leaveError = 'Could not leave the room. Please try again.';
				leavingRoom = false;
				return;
			}
		} catch {
			leaveError = 'Could not leave the room. Please try again.';
			leavingRoom = false;
			return;
		}
		myRooms = myRooms.filter((r) => r.roomId !== rid);
		leavingRoom = false;
		leaveTargetRoomId = null;
	}

	/** Redirects to the room named by ?next, if present and the user is signed in. */
	function redirectToNextIfPresent() {
		if (!auth) return false;
		const rawNext = $page.url.searchParams.get('next');
		const nextRoomId = rawNext ? parseRoomIdInput(rawNext) : null;
		if (!nextRoomId) return false;
		goto(`/${nextRoomId}`, { replaceState: true });
		return true;
	}

	/** @param {string} festivalId */
	async function doCreateRoom(festivalId) {
		creatingFestivalId = festivalId;
		errorMsg = '';
		try {
			const festival = FESTIVALS.find((f) => f.id === festivalId);
			if (!festival) throw new Error('Festival not found');

			const roomId = generateRoomId(festival.prefix);
			const resp = await fetch('/api/stagehopper/rooms', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ roomId })
			});
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			goto(`/${roomId}`);
		} catch {
			errorMsg = 'Could not create room. Please try again.';
			creatingFestivalId = null;
		}
	}

	/** @param {string} festivalId */
	function createRoom(festivalId) {
		if (!auth) {
			pendingLandingAction = { type: 'create', festivalId };
			googleAuthError = '';
			signinGateOpen = true;
			void initSigninGateGoogleAuth();
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
			pendingLandingAction = { type: 'join' };
			googleAuthError = '';
			signinGateOpen = true;
			void initSigninGateGoogleAuth();
			return;
		}
		joining = true;
		goto(`/${roomId}`);
	}

	/** @param {{ credential?: string }} response */
	function handleGoogleCredentialResponse(response) {
		const idToken = response?.credential ?? '';
		const claims = parseGoogleIdTokenClaims(idToken);
		if (!idToken || !claims) {
			googleAuthError = 'Google sign-in failed. Please try again.';
			return;
		}
		const identity = { idToken, sub: claims.sub, name: claims.name, givenName: claims.givenName };
		saveGoogleAuth(identity);
		auth = identity;
		googleAuthError = '';
		signinGateOpen = false;

		const action = pendingLandingAction;
		pendingLandingAction = null;
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
		}
	}

	async function initSigninGateGoogleAuth() {
		const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
		if (!clientId) {
			googleAuthError = 'Google auth is unavailable.';
			return;
		}

		const scriptLoaded = await loadGoogleScript();
		if (!scriptLoaded) {
			googleAuthError = 'Google auth script failed to load.';
			return;
		}

		const accountsApi = getGoogleAccountsApi();
		if (!accountsApi) {
			googleAuthError = 'Google auth is unavailable.';
			return;
		}

		accountsApi.initialize({
			client_id: clientId,
			callback: handleGoogleCredentialResponse,
			auto_select: true,
			use_fedcm_for_prompt: true
		});
		if (signinGateButtonEl) {
			signinGateButtonEl.innerHTML = '';
			accountsApi.renderButton(signinGateButtonEl, {
				theme: 'outline',
				size: 'large',
				shape: 'pill',
				text: 'continue_with',
				width: 280
			});
		}
		accountsApi.prompt();
	}

	function cancelSigninGate() {
		signinGateOpen = false;
		pendingLandingAction = null;
	}

	async function initGoogleAuth() {
		const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
		googleAuthEnabled = Boolean(clientId);
		if (!googleAuthEnabled || auth) {
			return;
		}

		const scriptLoaded = await loadGoogleScript();
		if (!scriptLoaded) {
			googleAuthError = 'Google auth script failed to load.';
			return;
		}

		const accountsApi = getGoogleAccountsApi();
		if (!accountsApi) {
			googleAuthError = 'Google auth is unavailable.';
			return;
		}

		accountsApi.initialize({
			client_id: clientId,
			callback: handleGoogleCredentialResponse,
			auto_select: true,
			use_fedcm_for_prompt: true
		});
		if (googleButtonEl) {
			googleButtonEl.innerHTML = '';
			accountsApi.renderButton(googleButtonEl, {
				theme: 'outline',
				size: 'large',
				shape: 'pill',
				text: 'continue_with',
				width: 280
			});
		}
		accountsApi.prompt();
	}

	function signOut() {
		clearGoogleAuth();
		auth = null;
		myRooms = [];
		void initGoogleAuth();
	}

	onMount(() => {
		auth = loadGoogleAuth();
		if (!redirectToNextIfPresent()) {
			void loadMyRooms();
		}
		void initGoogleAuth();
	});
</script>

<svelte:head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<meta name="description" content="StageHopper – plan festivals with your friends." />
	<title>StageHopper</title>
</svelte:head>

{#if leaveTargetRoomId}
	<div class="modal-backdrop">
		<div class="modal-card">
			<h2>Leave this room?</h2>
			<p class="modal-sub">Your picks in it will be deleted.</p>
			{#if leaveError}
				<p class="error">{leaveError}</p>
			{/if}
			<div class="dialog-actions">
				<button type="button" class="btn-secondary" onclick={cancelLeaveRoom} disabled={leavingRoom}>
					Cancel
				</button>
				<button type="button" class="btn-primary" onclick={confirmLeaveRoom} disabled={leavingRoom}>
					{leavingRoom ? 'Leaving…' : 'Leave room'}
				</button>
			</div>
		</div>
	</div>
{/if}

{#if signinGateOpen}
	<div class="modal-backdrop">
		<div class="modal-card">
			<h2>Sign in to continue</h2>
			<p class="modal-sub">
				Sign in with Google to {pendingLandingAction?.type === 'join' ? 'join' : 'create'} a room.
			</p>
			<div class="google-auth-button" bind:this={signinGateButtonEl}></div>
			{#if googleAuthError}
				<p class="error">{googleAuthError}</p>
			{/if}
			<div class="dialog-actions">
				<button type="button" class="btn-secondary" onclick={cancelSigninGate}>Cancel</button>
			</div>
		</div>
	</div>
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
					{auth.name} · <button type="button" class="link-btn" onclick={signOut}>Sign out</button>
				</p>
			{:else if googleAuthEnabled}
				<div class="google-auth-button" bind:this={googleButtonEl}></div>
			{/if}
		</div>
		<h1>Plan your festival days, together.</h1>
		<p class="tagline">
			Browse the lineup, mark your must-sees, and see what your friends are going to — live.
		</p>
		{#if googleAuthError}
			<p class="error">{googleAuthError}</p>
		{/if}
	</header>

	<main class="content">
		{#if auth && myRooms.length > 0}
			<section class="section">
				<h2 class="section-title">Your rooms</h2>
				<div class="my-rooms">
					{#each myRooms as room (room.roomId)}
						<div class="my-room-item">
							<button type="button" class="my-room-btn" onclick={() => goto(`/${room.roomId}`)}>
								<span class="my-room-swatch" style="background:{room.color}"></span>
								<span class="my-room-label">
									{roomLabel(room.roomId)}
									{#if roomIsPast(room.roomId)}
										<span class="badge-past">(Past)</span>
									{/if}
								</span>
							</button>
							<button
								type="button"
								class="my-room-remove"
								aria-label="Leave {roomLabel(room.roomId)}"
								onclick={() => requestLeaveRoom(room.roomId)}
							>
								✕
							</button>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<section class="section">
			<h2 class="section-title">Festivals</h2>
			<div class="festival-grid">
				{#each FESTIVALS as festival (festival.id)}
					<div class="festival-card">
						<div class="festival-cover" style="background: {festival.accent}">
							<span class="festival-cover-emoji">{festival.emoji}</span>
							<span class="festival-badge" class:festival-badge-live={!festival.past}>
								{festival.past ? 'Past' : 'Upcoming'}
							</span>
						</div>
						<div class="festival-body">
							<div class="festival-name">{festival.name}</div>
							<div class="festival-subtitle">{festival.subtitle}</div>
							<div class="festival-actions">
								<a class="btn-secondary btn-sm" href="/{festival.id}">Browse</a>
								<button
									type="button"
									class="btn-primary btn-sm"
									onclick={() => createRoom(festival.id)}
									disabled={creatingFestivalId !== null}
								>
									{creatingFestivalId === festival.id ? 'Creating…' : 'Create room'}
								</button>
							</div>
						</div>
					</div>
				{/each}
			</div>
			{#if errorMsg}
				<p class="error">{errorMsg}</p>
			{/if}
		</section>

		<section class="section">
			<h2 class="section-title">Have a room code?</h2>
			<div class="join-row">
				<input
					type="text"
					placeholder="Room code, link, or name"
					bind:value={joinValue}
					onkeydown={(e) => {
						if (e.key === 'Enter') joinRoom();
					}}
				/>
				<button
					onclick={joinRoom}
					disabled={!joinValue.trim() || joining}
					class="btn-secondary"
				>
					Join
				</button>
			</div>
			{#if joinError}
				<p class="error">{joinError}</p>
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
		box-sizing: border-box;
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

	.festival-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 1.25rem;
	}

	.festival-card {
		border: 1px solid #2e2e2e;
		border-radius: 14px;
		overflow: hidden;
		background: #1e1e1e;
		transition:
			transform 0.15s,
			border-color 0.15s;
	}

	.festival-card:hover {
		border-color: #444;
		transform: translateY(-2px);
	}

	.festival-cover {
		position: relative;
		height: 100px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.festival-cover-emoji {
		font-size: 2.5rem;
		filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35));
	}

	.festival-badge {
		position: absolute;
		top: 0.6rem;
		right: 0.6rem;
		font-size: 0.7rem;
		font-weight: 600;
		padding: 0.2rem 0.55rem;
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.45);
		color: #fff;
		backdrop-filter: blur(2px);
	}

	.festival-badge-live {
		background: rgba(46, 204, 113, 0.85);
	}

	.festival-body {
		padding: 1rem;
	}

	.festival-name {
		font-weight: 600;
		font-size: 0.95rem;
		color: #fffaf0;
	}

	.festival-subtitle {
		font-size: 0.8rem;
		color: #aaa;
		margin-top: 0.3rem;
	}

	.festival-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.9rem;
	}

	.festival-actions .btn-sm {
		flex: 1;
	}

	.btn-sm {
		padding: 0.55rem 0.8rem;
		font-size: 0.85rem;
		width: auto;
		text-align: center;
	}

	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.75);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 50;
		padding: 1rem;
	}

	.modal-card {
		background: #232323;
		border: 1px solid #444;
		border-radius: 12px;
		padding: 2rem;
		max-width: 380px;
		width: 100%;
		text-align: left;
	}

	.modal-card h2 {
		margin: 0 0 0.4rem;
		font-size: 1.3rem;
		color: #fffaf0;
	}

	.modal-sub {
		color: #aaa;
		font-size: 0.85rem;
		margin: 0;
		line-height: 1.5;
	}

	.dialog-actions {
		display: flex;
		gap: 0.6rem;
		margin-top: 1.5rem;
	}

	.dialog-actions button {
		flex: 1;
	}

	.google-auth-button {
		display: flex;
		justify-content: center;
		min-height: 40px;
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

	.my-rooms {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		text-align: left;
	}

	.my-room-item {
		display: flex;
		align-items: stretch;
		gap: 0.5rem;
	}

	.my-room-btn {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.75rem 1rem;
		border: 1px solid #2e2e2e;
		border-radius: 8px;
		background: #1e1e1e;
		color: #fffaf0;
		cursor: pointer;
		text-align: left;
		transition: all 0.15s;
	}

	.my-room-btn:hover {
		background: #262626;
		border-color: #444;
	}

	.my-room-swatch {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.my-room-label {
		font-size: 0.9rem;
		font-weight: 600;
	}

	.my-room-remove {
		width: 40px;
		flex-shrink: 0;
		border: 1px solid #2e2e2e;
		border-radius: 8px;
		background: #1e1e1e;
		color: #999;
		cursor: pointer;
		font-size: 0.9rem;
		transition: all 0.15s;
	}

	.my-room-remove:hover {
		color: #e74c3c;
		border-color: #e74c3c;
	}

	.badge-past {
		font-size: 0.75rem;
		color: #999;
		font-weight: 400;
	}

	.join-row {
		display: flex;
		gap: 0.5rem;
	}

	.join-row input {
		flex: 1;
		min-width: 0;
		padding: 0.7rem 0.9rem;
		border-radius: 8px;
		border: 1px solid #444;
		background: rgba(20, 20, 20, 0.8);
		color: #fffaf0;
		font-size: 0.95rem;
	}

	.btn-primary {
		background: #e74c3c;
		color: white;
		border: none;
		border-radius: 8px;
		padding: 0.8rem 2rem;
		font-size: 1rem;
		font-weight: 600;
		cursor: pointer;
		width: 100%;
		transition: background 0.15s;
	}

	.btn-primary:hover:not(:disabled) {
		background: #c0392b;
	}

	.btn-primary:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.btn-secondary {
		background: transparent;
		border: 1px solid #555;
		color: #fffaf0;
		border-radius: 8px;
		padding: 0.7rem 1.2rem;
		font-size: 0.95rem;
		font-weight: 600;
		cursor: pointer;
		white-space: nowrap;
		transition: background 0.15s;
		text-decoration: none;
		display: inline-block;
	}

	.btn-secondary:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.08);
	}

	.btn-secondary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.error {
		color: #e74c3c;
		font-size: 0.85rem;
		margin-top: 1rem;
	}

	/* ====== Mobile Optimizations ====== */
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
