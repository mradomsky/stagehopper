<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import ArtistDetailsCard from '$lib/stagehopper/components/ArtistDetailsCard.svelte';
	import AttendeesPopover from '$lib/stagehopper/components/AttendeesPopover.svelte';
	import ConfirmDialog from '$lib/stagehopper/components/ConfirmDialog.svelte';
	import JoinRoomModal from '$lib/stagehopper/components/JoinRoomModal.svelte';
	import MapOverlay from '$lib/stagehopper/components/MapOverlay.svelte';
	import MobileBottomBar from '$lib/stagehopper/components/MobileBottomBar.svelte';
	import NotificationsModal from '$lib/stagehopper/components/NotificationsModal.svelte';
	import ParticipantLegend from '$lib/stagehopper/components/ParticipantLegend.svelte';
	import PicksList from '$lib/stagehopper/components/PicksList.svelte';
	import RoomNav from '$lib/stagehopper/components/RoomNav.svelte';
	import SignInModal from '$lib/stagehopper/components/SignInModal.svelte';
	import StatusBar from '$lib/stagehopper/components/StatusBar.svelte';
	import TimetableGrid from '$lib/stagehopper/components/TimetableGrid.svelte';
	import { auth } from '$lib/stagehopper/auth.svelte.js';
	import { RoomState } from '$lib/stagehopper/room-state.svelte.js';
	import type { ParticipantMark } from '$lib/stagehopper/types.js';

	const room = new RoomState({ navigate: (url) => void goto(url) });

	/** Injected at build time (see vite.config.ts); the deployed release tag, `dev` locally. */
	const version = import.meta.env.VITE_VERSION ?? 'dev';
	const versionMenuItem = {
		label: `Version ${version}`,
		onSelect: () =>
			window.open(
				`https://github.com/mradomsky/stagehopper/releases/tag/${version}`,
				'_blank',
				'noopener'
			)
	};

	/** Push-notification settings popup, opened from the More menu. */
	let showNotifications = $state(false);

	/** The attendee pill's expanded popover: who it's for, and where to anchor it. Null when closed. */
	let attendeesPopover = $state<{ marks: ParticipantMark[]; anchorRect: DOMRect } | null>(null);

	/**
	 * Notifications key on a signed-in identity. A guest without one is sent through sign-in
	 * first (the popup would only show "sign in" otherwise); everyone else opens the popup.
	 */
	const notificationsMenuItem = {
		label: 'Notifications',
		onSelect: () =>
			room.isGuestMode && !room.hasGlobalAuth
				? room.openGuestSignin()
				: (showNotifications = true)
	};

	// Clerk's prebuilt sign-in reports completion by establishing a session, not by calling
	// back, so both gates below are closed by watching for the user to appear.
	$effect(() => {
		if (!auth.user) return;
		if (room.reauthRequired) room.handleReauthenticated();
		else if (room.guestSigninOpen) room.handleSignedIn();
	});

	/** The room already bootstrapped, so route changes only re-run on a real switch. */
	let bootstrappedRoomId: string | null = null;

	$effect(() => {
		const roomId = page.params.roomId;
		if (!browser || !roomId || roomId === bootstrappedRoomId) return;
		bootstrappedRoomId = roomId;
		attendeesPopover = null;
		void room.bootstrap(roomId);
	});

	/** How long the deep-link spotlight lingers before it's cleared (covers the CSS flash). */
	const HIGHLIGHT_MS = 2600;
	/** The last hash we resolved, so re-runs (and timetable-ready re-fires) don't loop. */
	let lastHandledHash = '';

	/**
	 * Deep-link tap-through (issue #69): a `#perf-{id}` hash — arriving fresh or pushed onto an
	 * already-open room by the notification click — switches to the set's day, scrolls it into
	 * view and flashes it. Unknown ids are ignored (and left unhandled, so a not-yet-loaded
	 * timetable gets another shot once its days arrive).
	 */
	function handlePerfHash() {
		if (!browser) return;
		const match = /^#perf-([A-Za-z0-9_-]+)$/.exec(location.hash);
		const perfId = match?.[1];
		if (!perfId) {
			lastHandledHash = location.hash;
			return;
		}
		if (!room.focusPerformance(perfId)) return;
		lastHandledHash = location.hash;
		void tick().then(() => {
			document
				.getElementById(`perf-${perfId}`)
				?.scrollIntoView({ block: 'center', behavior: 'smooth' });
		});
		window.setTimeout(() => {
			if (room.highlightedPerfId === perfId) room.highlightedPerfId = null;
		}, HIGHLIGHT_MS);
	}

	// Re-attempt whenever the timetable's days change (initial load, or a room switch), so a hash
	// present before the timetable resolved still resolves once it's in.
	$effect(() => {
		void room.timetable.days.length;
		if (browser && location.hash !== lastHandledHash) handlePerfHash();
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
					{ label: 'Sign out', onSelect: () => void room.signOut() }
				]),
		...(room.mapUrl ? [{ label: 'Map', onSelect: () => room.openMap() }] : []),
		notificationsMenuItem,
		versionMenuItem
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
			// updateViaCache: 'none' forces the browser to revalidate sw.js against the
			// network instead of trusting its HTTP cache. Safari (iOS especially) honours
			// the script's own Cache-Control here, so a long-lived `immutable` copy could
			// otherwise pin a stale worker — and a worker predating the push handler
			// accepts subscriptions while silently dropping every push it receives.
			navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
		}
		document.addEventListener('visibilitychange', handleVisibilityChange);
		window.addEventListener('pagehide', flushOnPageHide);
		// A notification tap on an already-open room only changes the hash — catch it live.
		window.addEventListener('hashchange', handlePerfHash);
	});

	onDestroy(() => {
		if (browser) {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			window.removeEventListener('pagehide', flushOnPageHide);
			window.removeEventListener('hashchange', handlePerfHash);
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
		<SignInModal title="Session expired" error={room.signInError} />
	{/if}

	<!-- Guest gate: browsing without a room, the first gated tap prompts sign-in. -->
	{#if room.guestSigninOpen}
		<SignInModal
			title="Sign in to continue"
			error={room.signInError}
			onCancel={() => room.cancelGuestSignin()}
		/>
	{/if}

	{#if showNotifications}
		<NotificationsModal
			onClose={() => (showNotifications = false)}
			onSettingsChange={(settings) => room.setNotificationSettings(settings)}
		/>
	{/if}

	{#if room.detailsPerformance}
		{@const performance = room.detailsPerformance}
		<ArtistDetailsCard
			{performance}
			stageName={room.detailsStageName}
			state={room.myState(performance.id)}
			marks={room.otherParticipantMarks(performance.id)}
			onToggleMark={() => room.togglePerformance(performance.id)}
			notifyOn={room.notificationsAvailable && room.notifyStateOf(performance.id)}
			notificationsAvailable={room.notificationsAvailable}
			onToggleNotify={() =>
				room.notificationsAvailable
					? room.toggleNotifyOverride(performance.id)
					: (showNotifications = true)}
			onClose={() => room.closeDetails()}
		/>
	{/if}

	{#if room.mapOpen && room.mapUrl}
		<MapOverlay mapUrl={room.mapUrl} onClose={() => room.closeMap()} />
	{/if}

	{#if attendeesPopover}
		<AttendeesPopover
			marks={attendeesPopover.marks}
			anchorRect={attendeesPopover.anchorRect}
			onClose={() => (attendeesPopover = null)}
		/>
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
			showFilters={!room.isGuestMode}
			participants={room.isGuestMode ? [] : room.allSelections}
			viewerUserId={room.userId}
			showingAll={room.showingAllParticipants}
			isSelected={(userId) => room.isParticipantSelected(userId)}
			onShowAll={() => room.resetParticipantFilter()}
			onToggleParticipant={(userId) => room.toggleParticipantFilter(userId)}
		/>

		<StatusBar error={room.syncError} message={room.statusMessage} />

		{#if room.viewMode === 'picks'}
			<PicksList
				groups={room.pickGroups}
				todayDate={room.todayDate}
				scrollTargetId={room.pickScrollTargetId}
				stateOf={(performanceId) => room.myState(performanceId)}
				marksOf={(performanceId) => room.otherParticipantMarks(performanceId)}
				notifyStateOf={(performanceId) => room.notifyStateOf(performanceId)}
				notificationsAvailable={room.notificationsAvailable}
				onOpen={(performanceId) => room.openDetailsById(performanceId)}
				onToggleBell={(performanceId) =>
					room.notificationsAvailable
						? room.toggleNotifyOverride(performanceId)
						: (showNotifications = true)}
				onBrowseTimetable={() => room.setViewMode('full')}
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
				stageColors={room.stageColors}
				inert={room.joinModalOpen}
				stateOf={(performanceId) => room.myState(performanceId)}
				marksOf={(performanceId) => room.otherParticipantMarks(performanceId)}
				notifyOf={(performanceId) =>
					room.notificationsAvailable && room.notifyStateOf(performanceId)}
				onOpenDetails={(performance, stageName) => room.openDetails(performance, stageName)}
				onToggleMark={(performanceId) => room.togglePerformance(performanceId)}
				onOpenAttendees={(marks, anchorRect) => (attendeesPopover = { marks, anchorRect })}
				onSwipeDay={(delta) => room.stepDay(delta)}
				isFavouriteStage={(stageName) => room.isFavouriteStage(stageName)}
				onToggleFavourite={(stageName) => room.toggleFavouriteStage(stageName)}
				picksOnly={room.picksOnly}
				onTogglePicks={room.isGuestMode ? undefined : () => room.togglePicksOnly()}
					highlightedId={room.highlightedPerfId}
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
