<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { browser } from '$app/environment';
	import ArtistDetailsCard from '$lib/stagehopper/components/ArtistDetailsCard.svelte';
	import AttendeesPopover from '$lib/stagehopper/components/AttendeesPopover.svelte';
	import ColourModal from '$lib/stagehopper/components/ColourModal.svelte';
	import MapOverlay from '$lib/stagehopper/components/MapOverlay.svelte';
	import MobileBottomBar from '$lib/stagehopper/components/MobileBottomBar.svelte';
	import Modal from '$lib/stagehopper/components/Modal.svelte';
	import NotificationsModal from '$lib/stagehopper/components/NotificationsModal.svelte';
	import PicksList from '$lib/stagehopper/components/PicksList.svelte';
	import RoomNav from '$lib/stagehopper/components/RoomNav.svelte';
	import SignInModal from '$lib/stagehopper/components/SignInModal.svelte';
	import StatusBar from '$lib/stagehopper/components/StatusBar.svelte';
	import TimetableGrid from '$lib/stagehopper/components/TimetableGrid.svelte';
	import TimetableList from '$lib/stagehopper/components/TimetableList.svelte';
	import ViewSwitchBar from '$lib/stagehopper/components/ViewSwitchBar.svelte';
	import { auth } from '$lib/stagehopper/auth.svelte.js';
	import { FestivalSpace, USERNAME_NOTICE } from '$lib/stagehopper/festival-space.svelte.js';
	import type { ParticipantMark } from '$lib/stagehopper/types.js';

	const space = new FestivalSpace();

	/** Injected at build time (see vite.config.ts); the deployed release tag, `dev` locally. */
	const version = import.meta.env.VITE_VERSION ?? 'dev';

	let showNotifications = $state(false);
	let infoOpen = $state(false);
	/** The Festival image failed to load: the dialog drops the hero and keeps the badge. */
	let imageFailed = $state(false);
	/** The Colour modal opened from the menu; a first Pick opens it through the space instead. */
	let colourEditOpen = $state(false);
	/** The Attendees pill's expanded popover: who is listed, how many more, and where to anchor. */
	let attendeesPopover = $state<{
		shown: ParticipantMark[];
		more: number;
		anchorRect: DOMRect;
	} | null>(null);

	/** There is a Timetable to switch the layout of. */
	const showTimetable = $derived(
		!space.timetableLoading && !space.timetableError && space.timetable.days.length > 0
	);
	const colourModalOpen = $derived(space.colourRequired || colourEditOpen);

	/** The pill draws those going; the popover lists everyone, going first, up to 50. */
	function openAttendees(_marks: ParticipantMark[], anchorRect: DOMRect, performanceId: string) {
		attendeesPopover = { ...space.attendees(performanceId), anchorRect };
	}

	async function chooseColour(colour: string) {
		await space.chooseColour(colour);
		if (space.profile?.colour === colour || space.notice === USERNAME_NOTICE) colourEditOpen = false;
	}

	function openColourModal() {
		space.clearColourError();
		colourEditOpen = true;
	}

	function cancelColour() {
		colourEditOpen = false;
		space.clearColourError();
		if (space.colourRequired) space.cancelColour();
	}

	// Clerk's prebuilt sign-in reports completion by establishing a session, not by calling
	// back, so the gate is closed by watching for the user to appear. Usually Clerk then
	// reloads the page and `open` finishes the Pending Pick from the URL instead.
	$effect(() => {
		if (auth.user && space.signInRequired) void space.onSignedIn();
	});

	$effect(() => {
		const id = page.params.id;
		if (!browser || !id) return;
		attendeesPopover = null;
		infoOpen = false;
		imageFailed = false;
		colourEditOpen = false;
		showNotifications = false;
		lastHandledHash = '';
		void space.open(id);
	});

	/** How long the deep-link spotlight lingers before it is cleared (covers the CSS flash). */
	const HIGHLIGHT_MS = 2600;
	/** The last hash handled, so re-runs (and timetable-ready re-fires) do not loop. */
	let lastHandledHash = '';

	/**
	 * Deep-link tap-through: a `#perf-{id}` hash, fresh or pushed onto an open page by a
	 * Reminder tap, switches to the set's Day, scrolls it into view and flashes it. Unknown ids
	 * stay unhandled so a Timetable that has not loaded yet gets another shot.
	 */
	function handlePerfHash() {
		if (!browser) return;
		const match = /^#perf-([A-Za-z0-9_-]+)$/.exec(location.hash);
		const perfId = match?.[1];
		if (!perfId) {
			lastHandledHash = location.hash;
			return;
		}
		if (!space.focusPerformance(perfId)) return;
		lastHandledHash = location.hash;
		void tick().then(() => {
			document
				.getElementById(`perf-${perfId}`)
				?.scrollIntoView({ block: 'center', behavior: 'smooth' });
		});
		window.setTimeout(() => {
			if (space.highlightedPerfId === perfId) space.highlightedPerfId = null;
		}, HIGHLIGHT_MS);
	}

	$effect(() => {
		void space.timetable.days.length;
		if (browser && location.hash !== lastHandledHash) handlePerfHash();
	});

	const menuItems = $derived([
		{ label: 'Description and dates', onSelect: () => (infoOpen = true) },
		...(space.mapUrl ? [{ label: 'Map', onSelect: () => space.openMap() }] : []),
		{ label: space.copied ? 'Copied!' : 'Share', onSelect: () => void space.share() },
		{
			label: 'Colour',
			onSelect: () => (space.signedIn ? openColourModal() : space.openSignIn())
		},
		{
			label: 'Notifications',
			onSelect: () => (space.signedIn ? (showNotifications = true) : space.openSignIn())
		},
		space.signedIn
			? { label: 'Sign out', onSelect: () => void space.signOut() }
			: { label: 'Sign in', onSelect: () => space.openSignIn() },
		{
			label: `Version ${version}`,
			onSelect: () =>
				window.open(
					`https://github.com/mradomsky/stagehopper/releases/tag/${version}`,
					'_blank',
					'noopener'
				)
		}
	]);

	onMount(() => {
		// A Reminder tap on an already-open page only changes the hash: catch it live.
		window.addEventListener('hashchange', handlePerfHash);
	});

	onDestroy(() => {
		if (browser) window.removeEventListener('hashchange', handlePerfHash);
		space.dispose();
	});
</script>

<svelte:head>
	<title>{space.festival ? `${space.festival.name} – StageHopper` : 'StageHopper'}</title>
</svelte:head>

<svelte:window onpopstate={() => space.handlePopState()} />

<div class="sh-festival">
	{#if space.signInRequired}
		<SignInModal title="Sign in to continue" onCancel={() => space.cancelSignIn()} />
	{/if}

	{#if colourModalOpen}
		<ColourModal
			selected={space.profile?.colour ?? null}
			error={space.colourError}
			onChoose={(colour) => void chooseColour(colour)}
			onCancel={cancelColour}
		/>
	{/if}

	{#if infoOpen && space.festival}
		{#snippet infoActions()}
			<button type="button" class="sh-btn sh-btn-secondary sh-btn-block" onclick={() => (infoOpen = false)}>
				Close
			</button>
		{/snippet}
		<Modal title={space.festival.name} subtitle={space.festival.subtitle} actions={infoActions}>
			{#snippet children()}
				{@const festival = space.festival}
				{#if festival?.imageUrl && !imageFailed}
					<div class="info-hero">
						<img class="info-hero-blur" src={festival.imageUrl} alt="" aria-hidden="true" />
						<img
							class="info-hero-image"
							src={festival.imageUrl}
							alt=""
							onerror={() => (imageFailed = true)}
						/>
						<span
							class="festival-badge"
							class:festival-badge-live={!festival.past}
							class:festival-badge-happening={festival.happeningNow}
						>
							{festival.past ? 'Past' : festival.happeningNow ? 'Happening now' : 'Upcoming'}
						</span>
					</div>
				{:else if festival}
					<span class="festival-badge festival-badge-inline" class:festival-badge-live={!festival.past}
						class:festival-badge-happening={festival.happeningNow}>
						{festival.past ? 'Past' : festival.happeningNow ? 'Happening now' : 'Upcoming'}
					</span>
				{/if}
				{#if space.festival?.description}
					<p class="info-description">{space.festival.description}</p>
				{/if}
			{/snippet}
		</Modal>
	{/if}

	{#if showNotifications}
		<NotificationsModal
			onClose={() => (showNotifications = false)}
			onSettingsChange={(settings) => space.setNotificationSettings(settings)}
		/>
	{/if}

	{#if space.detailsPerformance}
		{@const performance = space.detailsPerformance}
		<ArtistDetailsCard
			{performance}
			stageName={performance.stage}
			state={space.myState(performance.id)}
			marks={space.goingMarks(performance.id)}
			onToggleMark={() => space.togglePick(performance.id)}
			notifyOn={space.notificationsAvailable && space.notifyStateOf(performance.id)}
			notificationsAvailable={space.notificationsAvailable}
			onToggleNotify={() =>
				space.notificationsAvailable
					? space.toggleNotifyOverride(performance.id)
					: (showNotifications = true)}
			onOpenAttendees={openAttendees}
			onClose={() => space.closeDetails()}
		/>
	{/if}

	{#if space.mapOpen && space.mapUrl}
		<MapOverlay mapUrl={space.mapUrl} onClose={() => space.closeMap()} />
	{/if}

	{#if attendeesPopover}
		<AttendeesPopover
			marks={attendeesPopover.shown}
			more={attendeesPopover.more}
			anchorRect={attendeesPopover.anchorRect}
			onClose={() => (attendeesPopover = null)}
		/>
	{/if}

	<!-- The top bar and its menu stay in every state: description, dates, map and share
	     must stay reachable for a Festival whose Timetable has not been published. -->
	<RoomNav
		days={space.timetable.days}
		currentDayIdx={space.currentDayIdx}
		viewMode={space.viewMode}
		showViewTabs={true}
		showMap={!!space.mapUrl}
		{menuItems}
		onSelectDay={(index) => space.selectDay(index)}
		onSelectViewMode={(mode) => space.setViewMode(mode)}
		onOpenMap={() => space.openMap()}
	/>

	{#if showTimetable && space.viewMode !== 'picks'}
		<ViewSwitchBar layout={space.timetableLayout} onToggle={() => space.toggleTimetableLayout()} />
	{/if}

	<StatusBar error={space.syncError || space.notice} />

	{#if space.timetableLoading}
		<div class="sh-timetable-status">
			<p>Loading the timetable…</p>
		</div>
	{:else if space.timetableError}
		<div class="sh-timetable-status">
			{#if space.festival}
				<p class="sh-error">{space.timetableError}</p>
				<button
					type="button"
					class="sh-btn sh-btn-secondary"
					onclick={() => void space.retryTimetable()}
				>
					Try again
				</button>
			{:else}
				<p>That festival doesn't exist.</p>
				<a class="sh-btn sh-btn-secondary" href="/">Back to festivals</a>
			{/if}
		</div>
	{:else if space.timetable.days.length === 0}
		<div class="sh-timetable-status">
			<p>The timetable for this festival is not published yet.</p>
		</div>
	{:else if space.viewMode === 'picks'}
			<PicksList
				groups={space.myPicks}
				todayDate={space.todayDate}
				stageColors={space.stageColors}
				scrollTargetId={space.pickScrollTargetId}
				stateOf={(performanceId) => space.myState(performanceId)}
				marksOf={(performanceId) => space.goingMarks(performanceId)}
				notifyStateOf={(performanceId) => space.notifyStateOf(performanceId)}
				notificationsAvailable={space.notificationsAvailable}
				onOpen={(performanceId) => space.openDetailsById(performanceId)}
				onToggleBell={(performanceId) =>
					space.notificationsAvailable
						? space.toggleNotifyOverride(performanceId)
						: (showNotifications = true)}
				onBrowseTimetable={() => space.setViewMode('full')}
			/>
		{:else if space.timetableLayout === 'list'}
			<TimetableList
				groups={space.scheduleGroups}
				todayDate={space.todayDate}
				stageColors={space.stageColors}
				currentDayIdx={space.currentDayIdx}
				scrollTargetId={space.scheduleScrollTargetId}
				stateOf={(performanceId) => space.myState(performanceId)}
				marksOf={(performanceId) => space.goingMarks(performanceId)}
				onOpen={(performanceId) => space.openDetailsById(performanceId)}
				onToggleMark={(performanceId) => space.togglePick(performanceId)}
				onDayInView={(index) => space.selectDay(index)}
				highlightedId={space.highlightedPerfId}
			/>
		{:else}
			<TimetableGrid
				grid={space.grid}
				nowTopPx={space.nowVisible ? space.nowTopPx : null}
				stageColors={space.stageColors}
				inert={space.colourRequired}
				stateOf={(performanceId) => space.myState(performanceId)}
				marksOf={(performanceId) => space.goingMarks(performanceId)}
				notifyOf={(performanceId) =>
					space.notificationsAvailable && space.notifyStateOf(performanceId)}
				onOpenDetails={(performance) => space.openDetails(performance)}
				onToggleMark={(performanceId) => space.togglePick(performanceId)}
				onOpenAttendees={openAttendees}
				onSwipeDay={(delta) => space.stepDay(delta)}
				isFavouriteStage={(stageName) => space.isFavouriteStage(stageName)}
				onToggleFavourite={(stageName) => space.toggleFavouriteStage(stageName)}
				highlightedId={space.highlightedPerfId}
			/>
		{/if}

	<MobileBottomBar
		viewMode={space.viewMode}
		showViewTabs={true}
		showMap={!!space.mapUrl}
		{menuItems}
		onSelectViewMode={(mode) => space.setViewMode(mode)}
		onOpenMap={() => space.openMap()}
	/>
</div>

<style>
	.sh-festival {
		position: fixed;
		inset: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--sh-panel);
		color: var(--sh-text);
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

	.info-hero {
		position: relative;
		height: 180px;
		margin: 0 0 1rem;
		border-radius: 10px;
		overflow: hidden;
		background: var(--sh-surface);
	}

	.info-hero-image {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: contain;
		z-index: 1;
	}

	.info-hero-blur {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		filter: blur(24px) saturate(1.2);
		transform: scale(1.2);
	}

	.festival-badge {
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.25rem 0.65rem;
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.45);
		color: var(--sh-fixed-white);
	}

	.info-hero .festival-badge {
		position: absolute;
		top: 0.6rem;
		right: 0.6rem;
		z-index: 2;
	}

	.festival-badge-inline {
		display: inline-block;
		margin-bottom: 1rem;
	}

	.festival-badge-live {
		background: var(--sh-badge-upcoming);
		color: var(--sh-fixed-black);
	}

	.festival-badge-happening {
		background: var(--sh-badge-happening);
		color: var(--sh-fixed-white);
	}

	.info-description {
		margin: 0 0 1rem;
		color: var(--sh-text-soft);
		font-size: 0.95rem;
		line-height: 1.6;
		white-space: pre-wrap;
	}

	@media (max-width: 767px) {
		.sh-festival {
			font-size: 14px;
		}
	}

	/* Landscape phones: nav becomes a left rail, so the page lays out horizontally. */
	@media (max-width: 767px) and (orientation: landscape) {
		.sh-festival {
			flex-direction: row;
		}
	}
</style>
