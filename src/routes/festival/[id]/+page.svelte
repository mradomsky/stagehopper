<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import CreateRoomModal from '$lib/stagehopper/components/CreateRoomModal.svelte';
	import MyRoomsList from '$lib/stagehopper/components/MyRoomsList.svelte';
	import SignInModal from '$lib/stagehopper/components/SignInModal.svelte';
	import { createRoom, fetchRoomDisplayNames, listMyRooms } from '$lib/stagehopper/api.js';
	import { AuthGate } from '$lib/stagehopper/auth-gate.svelte.js';
	import { auth, loadAuth } from '$lib/stagehopper/auth.svelte.js';
	import { getFestivalById } from '$lib/stagehopper/festivals.svelte.js';
	import { generateRoomId, roomPath, validateRoomDisplayName } from '$lib/stagehopper/rooms.js';
	import type { RoomMembership } from '$lib/stagehopper/types.js';

	const festival = $derived(getFestivalById(page.params.id ?? ''));

	let imageFailed = $state(false);
	$effect(() => {
		void festival?.id;
		imageFailed = false;
	});

	let creating = $state(false);
	let errorMsg = $state('');
	let createRoomModalOpen = $state(false);

	/** The signed-in viewer's own rooms already created for this festival, so they can jump
	 *  back in rather than accidentally starting a duplicate. */
	let myFestivalRooms = $state<RoomMembership[]>([]);
	/** roomId → custom display name, for rooms that have one. Filled in after the room list
	 *  loads — a room's name isn't part of the membership row (see rooms.ts). */
	let roomDisplayNames = $state<Record<string, string>>({});

	async function loadFestivalRooms() {
		if (!festival || !auth.user) return;
		const result = await listMyRooms();
		if (!result.ok) return;
		const rooms = result.data.filter((room) => room.roomId.startsWith(festival.prefix));
		myFestivalRooms = rooms;
		roomDisplayNames = await fetchRoomDisplayNames(rooms);
	}

	let roomName = $state('');
	const roomNameError = $derived(validateRoomDisplayName(roomName));

	$effect(() => {
		if (auth.user && festival) void loadFestivalRooms();
	});

	onMount(() => {
		void loadAuth();
	});

	const gate = new AuthGate();
	$effect(() => {
		if (gate.open && auth.user) gate.handleSignedIn();
	});

	async function doCreateRoom() {
		if (!festival || roomNameError) return;
		creating = true;
		errorMsg = '';

		const roomId = generateRoomId(festival.prefix);
		const result = await createRoom(roomId, festival.id, roomName.trim() || undefined);
		if (!result.ok) {
			errorMsg = 'Could not create room. Please try again.';
			creating = false;
			return;
		}
		void goto(roomPath(roomId));
	}

	function plusClicked() {
		gate.run(() => (createRoomModalOpen = true));
	}

	function cancelCreateRoom() {
		createRoomModalOpen = false;
		errorMsg = '';
	}
</script>

<svelte:head>
	<title>{festival ? `${festival.name} – StageHopper` : 'Festival not found – StageHopper'}</title>
</svelte:head>

{#if gate.open}
	<SignInModal title="Sign in to continue" error={gate.error} onCancel={() => gate.cancel()} />
{/if}

{#if createRoomModalOpen}
	<CreateRoomModal
		bind:roomName
		nameError={roomNameError}
		{creating}
		error={errorMsg}
		onConfirm={() => void doCreateRoom()}
		onCancel={cancelCreateRoom}
	/>
{/if}

<div class="page">
	<a class="back-link" href="/">&larr; Back</a>

	{#if festival}
		<div class="hero">
			{#if festival.imageUrl && !imageFailed}
				<img class="hero-blur" src={festival.imageUrl} alt="" aria-hidden="true" />
				<img
					class="hero-image"
					src={festival.imageUrl}
					alt=""
					onerror={() => (imageFailed = true)}
				/>
			{/if}
			<span
				class="festival-badge"
				class:festival-badge-live={!festival.past}
				class:festival-badge-happening={festival.happeningNow}
			>
				{#if festival.past}
					Past
				{:else if festival.happeningNow}
					Happening now
				{:else}
					Upcoming
				{/if}
			</span>
		</div>

		<div class="info">
			<div class="title-row">
				<div class="title-text">
					<h1>{festival.name}</h1>
					<p class="subtitle">{festival.subtitle}</p>
				</div>
				<div class="title-actions">
					<a class="sh-btn sh-btn-secondary timetable-btn" href={roomPath(festival.id)}>
						Timetable
					</a>
					<button
						type="button"
						class="create-room-fab"
						onclick={plusClicked}
						aria-label="New room"
						title="New room"
					>
						+
					</button>
				</div>
			</div>

			{#if myFestivalRooms.length > 0}
				<div class="rooms-section">
					<h2 class="rooms-title">Your rooms</h2>
					<MyRoomsList
						rooms={myFestivalRooms}
						displayNames={roomDisplayNames}
						onOpen={(roomId) => void goto(roomPath(roomId))}
					/>
				</div>
			{/if}

			{#if festival.description}
				<p class="description">{festival.description}</p>
			{/if}
		</div>
	{:else}
		<p class="not-found">That festival doesn't exist.</p>
	{/if}
</div>

<style>
	.page {
		max-width: 720px;
		margin: 0 auto;
		padding: 1.5rem;
	}

	.back-link {
		display: inline-block;
		color: #aaa;
		text-decoration: none;
		font-size: 0.9rem;
		margin-bottom: 1.25rem;
	}

	.back-link:hover {
		color: #fffaf0;
	}

	.hero {
		position: relative;
		height: 320px;
		border-radius: 14px;
		overflow: hidden;
		background: #2a2a2a;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.hero-image {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: contain;
		z-index: 1;
	}

	.hero-blur {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		filter: blur(24px) saturate(1.2);
		transform: scale(1.2);
		z-index: 0;
	}

	.festival-badge {
		position: absolute;
		top: 0.9rem;
		right: 0.9rem;
		z-index: 2;
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.25rem 0.65rem;
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.45);
		color: #fff;
		backdrop-filter: blur(2px);
	}

	.festival-badge-live {
		background: rgba(241, 196, 15, 0.9);
		color: #000;
	}

	.festival-badge-happening {
		background: rgba(46, 204, 113, 0.85);
		color: #fff;
	}

	.info {
		margin-top: 1.5rem;
	}

	.title-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.title-text {
		min-width: 0;
	}

	h1 {
		margin: 0;
		font-size: 1.6rem;
		color: #fffaf0;
	}

	.subtitle {
		margin: 0.4rem 0 0;
		color: #aaa;
		font-size: 0.95rem;
	}

	.title-actions {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-shrink: 0;
	}

	.timetable-btn {
		padding: 0.5rem 1rem;
		white-space: nowrap;
	}

	.create-room-fab {
		width: 40px;
		height: 40px;
		flex-shrink: 0;
		border: none;
		border-radius: 50%;
		background: #e74c3c;
		color: #fff;
		font-size: 1.5rem;
		line-height: 1;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: background 0.12s;
	}

	.create-room-fab:hover {
		background: #c0392b;
	}

	.rooms-section {
		margin-top: 1.25rem;
	}

	.rooms-title {
		font-size: 0.85rem;
		font-weight: 600;
		color: #ddd;
		margin: 0 0 0.6rem;
	}

	.description {
		margin: 1rem 0 0;
		color: #ccc;
		font-size: 0.95rem;
		line-height: 1.6;
		white-space: pre-wrap;
	}

	.not-found {
		color: #aaa;
	}

	@media (max-width: 767px) {
		.hero {
			height: 220px;
		}
	}
</style>
