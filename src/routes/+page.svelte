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

	let creating = false;
	let errorMsg = '';
	let selectedFestivalId = FESTIVALS.find((f) => !f.past)?.id || FESTIVALS[0].id;

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

	/** @type {'create' | 'join' | null} */
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

	async function doCreateRoom() {
		creating = true;
		errorMsg = '';
		try {
			const festival = FESTIVALS.find((f) => f.id === selectedFestivalId);
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
			creating = false;
		}
	}

	function createRoom() {
		if (!auth) {
			pendingLandingAction = 'create';
			googleAuthError = '';
			signinGateOpen = true;
			void initSigninGateGoogleAuth();
			return;
		}
		void doCreateRoom();
	}

	function joinRoom() {
		joinError = '';
		const roomId = parseRoomIdInput(joinValue);
		if (!roomId) {
			joinError = 'Enter a room code, link, or name.';
			return;
		}
		if (!auth) {
			pendingLandingAction = 'join';
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
		if (action === 'create') {
			void doCreateRoom();
			return;
		}
		if (action === 'join') {
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
				Sign in with Google to {pendingLandingAction === 'join' ? 'join' : 'create'} a room.
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

<div class="overlay">
	<div class="card">
		<div class="logo">🎵</div>
		<h1>StageHopper</h1>

		<p class="tagline">
			Pick a festival, create a shared room, mark your must-sees, and see everyone's picks
			live.
		</p>

		{#if auth}
			<p class="signed-in-line">
				Signed in as {auth.name} ·
				<button type="button" class="link-btn" onclick={signOut}>Sign out</button>
			</p>
		{:else if googleAuthEnabled}
			<div class="google-auth-button" bind:this={googleButtonEl}></div>
		{/if}
		{#if googleAuthError}
			<p class="error">{googleAuthError}</p>
		{/if}

		{#if auth && myRooms.length > 0}
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
			<div class="divider">or join/create another</div>
		{/if}

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

		{#if FESTIVALS.some((f) => f.past)}
			<div class="divider">or browse a past festival</div>
			<div class="festival-list">
				{#each FESTIVALS.filter((f) => f.past) as festival (festival.id)}
					<a class="festival-item" href="/{festival.id}">
						<div class="festival-name">{festival.name}</div>
						<div class="festival-subtitle">{festival.subtitle}</div>
					</a>
				{/each}
			</div>
		{/if}

		<div class="divider">or create a new room</div>

		<div class="festival-list">
			{#each FESTIVALS as festival (festival.id)}
				<div
					class="festival-item"
					class:selected={selectedFestivalId === festival.id}
					onclick={() => {
						selectedFestivalId = festival.id;
					}}
					role="button"
					tabindex="0"
					onkeydown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							selectedFestivalId = festival.id;
						}
					}}
				>
					<div class="festival-name">
						{festival.name}
						{#if festival.past}
							<span class="badge-past">(Past)</span>
						{/if}
					</div>
					<div class="festival-subtitle">{festival.subtitle}</div>
				</div>
			{/each}
		</div>

		<button onclick={createRoom} disabled={creating} class="btn-primary">
			{creating ? 'Creating room…' : 'Create room'}
		</button>
		{#if errorMsg}
			<p class="error">{errorMsg}</p>
		{/if}
	</div>
</div>

<style>
	.overlay {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 100vh;
		padding: 2rem;
		box-sizing: border-box;
		pointer-events: auto;
	}

	.card {
		background: rgba(30, 30, 30, 0.92);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
		border: 1px solid #333;
		border-radius: 12px;
		padding: 2.5rem;
		max-width: 420px;
		width: 100%;
		text-align: center;
		color: #fffaf0;
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

	.logo {
		font-size: 3rem;
		margin-bottom: 0.5rem;
	}

	h1 {
		font-size: 2rem;
		margin: 0 0 1.5rem;
		color: #fffaf0;
	}

	.tagline {
		font-size: 0.95rem;
		color: #ccc;
		line-height: 1.6;
		margin: 0 0 1.5rem;
	}

	.google-auth-button {
		display: flex;
		justify-content: center;
		min-height: 40px;
	}

	.signed-in-line {
		font-size: 0.85rem;
		color: #aaa;
		margin: 0 0 1.5rem;
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
		margin-bottom: 0.5rem;
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
		border: 2px solid #333;
		border-radius: 8px;
		background: rgba(40, 40, 40, 0.6);
		color: #fffaf0;
		cursor: pointer;
		text-align: left;
		transition: all 0.15s;
	}

	.my-room-btn:hover {
		background: rgba(50, 50, 50, 0.8);
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
		border: 2px solid #333;
		border-radius: 8px;
		background: rgba(40, 40, 40, 0.6);
		color: #999;
		cursor: pointer;
		font-size: 0.9rem;
		transition: all 0.15s;
	}

	.my-room-remove:hover {
		color: #e74c3c;
		border-color: #e74c3c;
	}

	.join-row {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
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
	}

	.btn-secondary:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.08);
	}

	.btn-secondary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.divider {
		margin: 1.25rem 0 1rem;
		color: #777;
		font-size: 0.8rem;
		text-align: center;
	}

	.festival-list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-bottom: 1.5rem;
		text-align: left;
	}

	.festival-item {
		display: block;
		padding: 1rem;
		border: 2px solid #333;
		border-radius: 8px;
		background: rgba(40, 40, 40, 0.6);
		color: inherit;
		text-decoration: none;
		cursor: pointer;
		transition: all 0.15s;
	}

	.festival-item:hover {
		background: rgba(50, 50, 50, 0.8);
		border-color: #444;
	}

	.festival-item.selected {
		border-color: #e74c3c;
		background: rgba(231, 76, 60, 0.1);
	}

	.festival-name {
		font-weight: 600;
		font-size: 0.95rem;
		color: #fffaf0;
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.badge-past {
		font-size: 0.75rem;
		color: #999;
		font-weight: 400;
	}

	.festival-subtitle {
		font-size: 0.8rem;
		color: #aaa;
		margin-top: 0.35rem;
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

	.error {
		color: #e74c3c;
		font-size: 0.85rem;
		margin-top: 1rem;
	}

	/* ====== Mobile Optimizations ====== */
	@media (max-width: 767px) {
		.overlay {
			padding: 1rem;
		}

		.card {
			padding: 1.75rem 1.5rem;
			border-radius: 8px;
		}

		.logo {
			font-size: 2.5rem;
			margin-bottom: 0.4rem;
		}

		h1 {
			font-size: 1.5rem;
			margin-bottom: 0.75rem;
		}

		.tagline {
			font-size: 0.85rem;
			margin-bottom: 1.25rem;
			line-height: 1.5;
		}

		.festival-list {
			gap: 0.5rem;
			margin-bottom: 1.25rem;
		}

		.festival-item {
			padding: 0.75rem;
		}

		.festival-name {
			font-size: 0.9rem;
		}

		.festival-subtitle {
			font-size: 0.75rem;
			margin-top: 0.25rem;
		}

		.btn-primary {
			padding: 0.7rem 1.5rem;
			font-size: 0.95rem;
			min-height: 44px;
		}

		.error {
			font-size: 0.8rem;
			margin-top: 0.8rem;
		}
	}

	@media (max-width: 479px) {
		.overlay {
			padding: 0.75rem;
		}

		.card {
			padding: 1.5rem 1.25rem;
			border-radius: 6px;
		}

		.logo {
			font-size: 2rem;
			margin-bottom: 0.3rem;
		}

		h1 {
			font-size: 1.25rem;
			margin-bottom: 0.5rem;
		}

		.tagline {
			font-size: 0.8rem;
			margin-bottom: 1rem;
		}

		.join-row {
			flex-direction: column;
		}

		.festival-list {
			margin-bottom: 1.25rem;
		}

		.festival-name {
			font-size: 0.85rem;
		}

		.btn-primary {
			padding: 0.6rem 1.25rem;
			font-size: 0.9rem;
		}
	}
</style>
