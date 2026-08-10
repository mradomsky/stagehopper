<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import ArtistDetailsCard from '$lib/stagehopper/components/ArtistDetailsCard.svelte';
	import ConfirmDialog from '$lib/stagehopper/components/ConfirmDialog.svelte';
	import GoogleSignInModal from '$lib/stagehopper/components/GoogleSignInModal.svelte';
	import JoinRoomModal from '$lib/stagehopper/components/JoinRoomModal.svelte';
	import LikedList from '$lib/stagehopper/components/LikedList.svelte';
	import MapOverlay from '$lib/stagehopper/components/MapOverlay.svelte';
	import MobileBottomBar from '$lib/stagehopper/components/MobileBottomBar.svelte';
	import ParticipantLegend from '$lib/stagehopper/components/ParticipantLegend.svelte';
	import RoomNav from '$lib/stagehopper/components/RoomNav.svelte';
	import StatusBar from '$lib/stagehopper/components/StatusBar.svelte';
	import TimetableGrid from '$lib/stagehopper/components/TimetableGrid.svelte';
	import { RoomState } from '$lib/stagehopper/room-state.svelte.js';

	const room = new RoomState({ navigate: (url) => void goto(url) });

	/** Injected at build time (see vite.config.ts); `dev` outside a git checkout. */
	const commit = import.meta.env.VITE_COMMIT ?? 'dev';
	const commitMenuItem = {
		label: `Version ${commit}`,
		onSelect: () =>
			window.open(`https://github.com/mradomsky/stagehopper/commit/${commit}`, '_blank', 'noopener')
	};

	/** The room already bootstrapped, so route changes only re-run on a real switch. */
	let bootstrappedRoomId: string | null = null;

	$effect(() => {
		const roomId = page.params.roomId;
		if (!browser || !roomId || roomId === bootstrappedRoomId) return;
		bootstrappedRoomId = roomId;
		void room.bootstrap(roomId);
	});

	/** Menu contents differ for guests browsing a lineup and members of a room. */
	const menuItems = $derived([
		...(room.isGuestMode
			? [
					...(room.hasGlobalAuth
						? []
						: [{ label: 'Sign in', onSelect: () => room.openGuestSignin() }]),
					{ label: room.copied ? 'Copied!' : 'Share', onSelect: () => void room.share() }
				]
			: [
					{ label: room.copied ? 'Copied!' : 'Share room', onSelect: () => void room.share() },
					{ label: 'Leave room', onSelect: () => room.openLeaveDialog() },
					{ label: 'Sign out', onSelect: () => room.signOut() }
				]),
		commitMenuItem
	]);

	/**
	 * A debounced pick must not be lost when the tab is backgrounded or closed. Polling
	 * pauses while hidden, so coming back also needs an immediate catch-up read — that
	 * is precisely when the viewer is looking at everyone else's picks.
	 */
	function handleVisibilityChange() {
		if (document.visibilityState === 'hidden') room.flushPendingWrites();
		else void room.refresh();
	}

	function flushOnPageHide() {
		room.flushPendingWrites();
	}

	onMount(() => {
		room.startClock();
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/sw.js').catch(() => {});
		}
		document.addEventListener('visibilitychange', handleVisibilityChange);
		window.addEventListener('pagehide', flushOnPageHide);
	});

	onDestroy(() => {
		if (browser) {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			window.removeEventListener('pagehide', flushOnPageHide);
		}
		room.dispose();
	});
</script>

<svelte:head>
	<title>StageHopper – Room</title>
</svelte:head>

<svelte:window onpopstate={() => room.handlePopState()} />

<div class="sh-room">
	{#if room.joinModalOpen}
		<JoinRoomModal
			bind:name={room.joinName}
			selectedColor={room.joinColor}
			takenColors={room.takenColors}
			onSelectColor={(color) => room.selectJoinColor(color)}
			onConfirm={() => room.confirmJoin()}
		/>
	{/if}

	{#if room.leaveDialogOpen}
		<ConfirmDialog
			title="Leave this room?"
			subtitle="Your picks in it will be deleted."
			error={room.leaveError}
			confirmLabel="Leave room"
			busyLabel="Leaving…"
			busy={room.leavingRoom}
			onConfirm={() => void room.confirmLeaveRoom()}
			onCancel={() => room.cancelLeaveDialog()}
		/>
	{/if}

	<!-- Expired session: re-authenticate in place, without navigating away. -->
	{#if room.reauthRequired}
		<GoogleSignInModal
			title="Session expired"
			subtitle="Sign in again with the same Google account to keep saving your picks."
			error={room.googleAuthError}
			onCredential={(response) => room.handleReauthCredential(response)}
		/>
	{/if}

	<!-- Guest gate: browsing without a room, the first gated tap prompts sign-in. -->
	{#if room.guestSigninOpen}
		<GoogleSignInModal
			title="Sign in to continue"
			subtitle="Sign in with Google to save your picks — we'll start a room for you."
			error={room.googleAuthError}
			onCredential={(response) => room.handleGuestCredential(response)}
			onCancel={() => room.cancelGuestSignin()}
		/>
	{/if}

	{#if room.detailsPerformance}
		{@const performance = room.detailsPerformance}
		<ArtistDetailsCard
			{performance}
			stageName={room.detailsStageName}
			liked={room.isLiked(performance.id)}
			onToggleLike={() => room.toggleLiked(performance.id)}
			state={room.myState(performance.id)}
			color={room.myColor}
			onToggleMark={() => room.togglePerformance(performance.id)}
			onClose={() => room.closeDetails()}
		/>
	{/if}

	{#if room.mapOpen && room.mapUrl}
		<MapOverlay mapUrl={room.mapUrl} onClose={() => room.closeMap()} />
	{/if}

	{#if room.timetableLoading}
		<div class="sh-timetable-status">
			<p>Loading the timetable…</p>
		</div>
	{:else if room.timetableError}
		<div class="sh-timetable-status">
			<p class="sh-error">{room.timetableError}</p>
			<button type="button" class="sh-btn sh-btn-secondary" onclick={() => void room.retryTimetable()}>
				Try again
			</button>
		</div>
	{:else}
		<RoomNav
			days={room.timetable.days}
			currentDayIdx={room.currentDayIdx}
			viewMode={room.viewMode}
			showViewTabs={!room.isGuestMode}
			showMap={!room.isGuestMode && !!room.mapUrl}
			{menuItems}
			onSelectDay={(index) => room.selectDay(index)}
			onSelectViewMode={(mode) => room.setViewMode(mode)}
			onOpenMap={() => room.openMap()}
		/>

		<ParticipantLegend
			dayCount={room.timetable.days.length}
			currentDayIdx={room.currentDayIdx}
			showFilters={!room.isGuestMode}
			participants={room.isGuestMode ? [] : room.allSelections}
			viewerUserId={room.userId}
			showingAll={room.showingAllParticipants}
			isSelected={(userId) => room.isParticipantSelected(userId)}
			onShowAll={() => room.resetParticipantFilter()}
			onToggleParticipant={(userId) => room.toggleParticipantFilter(userId)}
		/>

		<StatusBar error={room.syncError} message={room.statusMessage} />

		{#if room.viewMode === 'liked'}
			<LikedList
				performances={room.likedPerformances}
				onRemove={(performanceId) => room.toggleLiked(performanceId)}
				onOpen={(performanceId) => room.openDetailsById(performanceId)}
			/>
		{:else}
			<TimetableGrid
				stages={room.visibleStages}
				hourMarkers={room.hourMarkers}
				gridStartMin={room.gridStartMin}
				gridHeightPx={room.gridHeightPx}
				nowTopPx={room.nowTopPx}
				nowVisible={room.nowVisible}
				color={room.myColor}
				inert={room.joinModalOpen}
				stateOf={(performanceId) => room.myState(performanceId)}
				marksOf={(performanceId) => room.otherParticipantMarks(performanceId)}
				onOpenDetails={(performance, stageName) => room.openDetails(performance, stageName)}
				onToggleMark={(performanceId) => room.togglePerformance(performanceId)}
				onSwipeDay={(delta) => room.stepDay(delta)}
				isFavouriteStage={(stageName) => room.isFavouriteStage(stageName)}
				onToggleFavourite={(stageName) => room.toggleFavouriteStage(stageName)}
				picksOnly={room.picksOnly}
				onTogglePicks={room.isGuestMode ? undefined : () => room.togglePicksOnly()}
			/>
		{/if}
	{/if}

	<MobileBottomBar
		viewMode={room.viewMode}
		showViewTabs={!room.isGuestMode}
		showMap={!room.isGuestMode && !!room.mapUrl}
		{menuItems}
		onSelectViewMode={(mode) => room.setViewMode(mode)}
		onOpenMap={() => room.openMap()}
	/>
</div>

<style>
	.sh-room {
		position: fixed;
		inset: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: rgba(18, 18, 18, 0.97);
		color: #fffaf0;
	}

	.sh-timetable-status {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		padding: 2rem;
		text-align: center;
	}

	@media (max-width: 767px) {
		.sh-room {
			font-size: 14px;
		}
	}

	/* Landscape phones: nav becomes a left rail, so the room lays out horizontally. */
	@media (max-width: 767px) and (orientation: landscape) {
		.sh-room {
			flex-direction: row;
		}
	}
</style>
