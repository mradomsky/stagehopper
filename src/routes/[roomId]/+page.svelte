<script>
	import { page } from '$app/stores';
	import { browser } from '$app/environment';
	import { onDestroy, onMount } from 'svelte';
	import primaryTimetable from '$lib/stagehopper/timetable.json';
	import tomorrowlandRaw from '$lib/stagehopper/timetable-tmr26.json';
	import {
		colorWithOpacity,
		cycleState,
		filterSelectionsByParticipantIds,
		filterPicks,
		getParticipantInitial,
		getSelectionVisuals,
		mergeSelectionsForViewer,
		normalizeSelectedOtherUserIds,
		normalizeTimetable,
		shouldTriggerDaySwipe,
		timeToGridMin
	} from '$lib/stagehopper/utils.js';
	import { getFestivalByPrefix } from '$lib/stagehopper/festivals.js';

	const COLORS = [
		'#e74c3c',
		'#3498db',
		'#2ecc71',
		'#f39c12',
		'#9b59b6',
		'#1abc9c',
		'#fd79a8',
		'#fdcb6e'
	];

	const PX_PER_MIN = 1.5;
	const COL_WIDTH = typeof window !== 'undefined' && window.innerWidth < 768 ? 100 : 160;
	const TIME_COL_W = typeof window !== 'undefined' && window.innerWidth < 768 ? 40 : 52;
	const HEADER_H = typeof window !== 'undefined' && window.innerWidth < 768 ? 40 : 44;

	/** @typedef {'anonymous' | ''} AuthMode */
	/** @typedef {'join'} ModalMode */
	/** @typedef {{ userId:string; name:string; color:string; selections:Record<string,0|1|2> }} RoomSelection */

	/** @param {string} hhmm */
	function timeToTop(hhmm) {
		return (timeToGridMin(hhmm) - GRID_START_MIN) * PX_PER_MIN;
	}

	/**
	 * @param {string} startTime
	 * @param {string} endTime
	 */
	function durationPx(startTime, endTime) {
		return Math.max(22, (timeToGridMin(endTime) - timeToGridMin(startTime)) * PX_PER_MIN);
	}

	// Compute globally from all days' performances
	function computeGridStart(days) {
		let earliest = Infinity;
		for (const day of days ?? []) {
			for (const p of day.performances ?? []) {
				const m = timeToGridMin(p.startTime);
				// Only consider daytime starts (not post-midnight, i.e. < 1440)
				if (m < 1440 && m < earliest) earliest = m;
			}
		}
		if (!isFinite(earliest)) return 9 * 60;
		return Math.max(0, earliest - 150); // 2.5h = 150 min before earliest
	}

	$: GRID_START_MIN = computeGridStart(timetable.days);
	$: GRID_END_MIN = GRID_START_MIN + 24 * 60; // always 24h window from grid start
	$: GRID_HEIGHT = (GRID_END_MIN - GRID_START_MIN) * PX_PER_MIN;
	$: HOUR_MARKERS = (() => {
		const markers = [];
		const startHour = Math.floor(GRID_START_MIN / 60);
		for (let i = 0; i < 24; i++) {
			const h = (startHour + i) % 24;
			const min = h * 60;
			const gridMin = min < GRID_START_MIN ? min + 1440 : min;
			const label = `${String(h).padStart(2, '0')}:00`;
			markers.push({ label, top: (gridMin - GRID_START_MIN) * PX_PER_MIN });
		}
		return markers;
	})();

	let roomId = '';
	let userId = '';
	let myName = '';
	let myColor = COLORS[0];
	let authMode = /** @type {AuthMode} */ ('');

	let modalName = '';
	let modalColor = COLORS[0];
	let modalColorDirty = false;
	let showModal = true;
	let modalMode = /** @type {ModalMode} */ ('join');

	let currentDayIdx = 0;
	let viewMode = /** @type {'full'|'picks'|'liked'} */ ('full');
	let nowMin = -1;
	/** @type {ReturnType<typeof setInterval> | null} */
	let nowIntervalId = null;
	/** @type {string[] | null} */
	let selectedOtherUserIds = null;

	/** @type {Record<string,0|1|2>} */
	let mySelections = {};

	/** @type {Set<string>} */
	let likedIds = new Set();

	function loadLiked(rid) {
		try {
			const raw = localStorage.getItem(`stagehopper:${rid}:liked`);
			return new Set(raw ? JSON.parse(raw) : []);
		} catch {
			return new Set();
		}
	}

	function saveLiked(rid, ids) {
		localStorage.setItem(`stagehopper:${rid}:liked`, JSON.stringify([...ids]));
	}

	function toggleLiked(perfId) {
		const next = new Set(likedIds);
		if (next.has(perfId)) next.delete(perfId);
		else next.add(perfId);
		likedIds = next;
		saveLiked(roomId, likedIds);
		haptic();
	}

	/** @type {RoomSelection[]} */
	let allSelections = [];

	let syncError = '';
	let copied = false;

	/** @type {HTMLDivElement | null} */
	let gridScrollEl = null;
	/** @type {ReturnType<typeof setTimeout> | null} */
	let putTimer = null;
	/** @type {ReturnType<typeof setInterval> | null} */
	let pollInterval = null;

	$: {
		const festival = getFestivalByPrefix(roomId);
		if (festival?.id === 'tmr26') {
			timetable = normalizeTimetable(tomorrowlandRaw, 'tmr26');
		} else {
			timetable = primaryTimetable;
		}
		currentDayIdx = getInitialDayIdx(timetable.days);
	}

	/** @type {any} */
	let timetable = primaryTimetable;

	$: STAGE_ORDER = (() => {
		/** @type {string[]} */
		const order = [];
		for (const day of timetable.days ?? []) {
			for (const p of day.performances ?? []) {
				if (!order.includes(p.stage)) order.push(p.stage);
			}
		}
		return order;
	})();

	$: currentDay = timetable.days[currentDayIdx];

	$: stagesForDay = (() => {
		/** @type {Record<string, typeof timetable.days[0]['performances']>} */
		const byStage = {};
		for (const p of currentDay?.performances ?? []) {
			if (!byStage[p.stage]) byStage[p.stage] = [];
			byStage[p.stage].push(p);
		}
		return STAGE_ORDER.map((name) => ({ name, performances: byStage[name] ?? [] })).filter(
			(s) => s.performances.length > 0
		);
	})();

	$: otherParticipants = allSelections.filter((selection) => selection.userId !== userId);
	$: filteredSelections = filterSelectionsByParticipantIds(
		allSelections,
		userId,
		selectedOtherUserIds
	);
	$: visibleStages =
		viewMode === 'picks' ? filterPicks(stagesForDay, filteredSelections) : stagesForDay;
	$: showingAllParticipants = selectedOtherUserIds === null;
	$: roomId = $page.params.roomId;
	$: nowTop = (nowMin - GRID_START_MIN) * PX_PER_MIN;
	$: nowVisible = nowMin >= GRID_START_MIN && nowMin < GRID_END_MIN;
	$: statusMessage =
		viewMode === 'picks' && visibleStages.length === 0
			? Object.values(mySelections).some((v) => v > 0)
				? 'No picks yet — mark some performances first.'
				: 'After you mark performances, you can see them in your picks.'
			: '';
	$: likedPerformances = (() => {
		/** @type {Array<{id:string; artist:string; stage:string; startTime:string; endTime:string; date:string; dayLabel:string}>} */
		const result = [];
		for (const day of timetable.days ?? []) {
			for (const p of day.performances ?? []) {
				if (likedIds.has(p.id)) {
					result.push({
						id: p.id,
						artist: p.artist,
						stage: p.stage,
						startTime: p.startTime,
						endTime: p.endTime,
						date: day.date,
						dayLabel: day.label
					});
				}
			}
		}
		return result.sort(
			(a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime)
		);
	})();

	/**
	 * @param {string} performanceId
	 * @returns {{ userId:string; name:string; color:string; state:0|1|2 }[]}
	 */
	function getParticipantMarks(performanceId) {
		return filteredSelections
			.map((sel) => ({
				userId: sel.userId,
				name: sel.name,
				color: sel.color,
				state: /** @type {0|1|2} */ (sel.selections[performanceId] ?? 0)
			}))
			.filter((mark) => mark.state > 0);
	}

	/**
	 * @param {string} rid
	 * @returns {{
	 * 	authMode: string
	 * 	anonymousIdentity: { userId: string; name: string; color: string } | null
	 * 	selectedOtherUserIds: string[] | null
	 * }}
	 */
	function loadRoomState(rid) {
		const authMode = localStorage.getItem(`stagehopper:${rid}:authMode`) ?? '';
		const userId = localStorage.getItem(`stagehopper:${rid}:userId`);
		const name = localStorage.getItem(`stagehopper:${rid}:name`);
		const color = localStorage.getItem(`stagehopper:${rid}:color`);
		const rawSelectedOtherUserIds = localStorage.getItem(`stagehopper:${rid}:selectedOtherUserIds`);
		let selectedOtherUserIds = null;
		if (rawSelectedOtherUserIds) {
			try {
				const parsed = JSON.parse(rawSelectedOtherUserIds);
				selectedOtherUserIds = Array.isArray(parsed) ? parsed : null;
			} catch {
				selectedOtherUserIds = null;
			}
		}

		return {
			authMode,
			anonymousIdentity:
				userId && name && color
					? {
							userId,
							name,
							color
						}
					: null,
			selectedOtherUserIds
		};
	}

	/**
	 * @param {string} rid
	 * @param {string} participantKey
	 * @param {string} name
	 * @param {string} color
	 */
	function saveAnonymousIdentity(rid, participantKey, name, color) {
		localStorage.setItem(`stagehopper:${rid}:authMode`, 'anonymous');
		localStorage.setItem(`stagehopper:${rid}:userId`, participantKey);
		localStorage.setItem(`stagehopper:${rid}:name`, name);
		localStorage.setItem(`stagehopper:${rid}:color`, color);
	}

	/**
	 * @param {string} rid
	 * @param {string[] | null} nextSelectedOtherUserIds
	 */
	function saveParticipantFilter(rid, nextSelectedOtherUserIds) {
		if (!nextSelectedOtherUserIds) {
			localStorage.removeItem(`stagehopper:${rid}:selectedOtherUserIds`);
			return;
		}
		localStorage.setItem(
			`stagehopper:${rid}:selectedOtherUserIds`,
			JSON.stringify(nextSelectedOtherUserIds)
		);
	}

	function reconcileParticipantFilter() {
		const availableOtherUserIds = allSelections
			.filter((selection) => selection.userId !== userId)
			.map((selection) => selection.userId);
		const normalized = normalizeSelectedOtherUserIds(selectedOtherUserIds, availableOtherUserIds);
		const changed =
			normalized === null
				? selectedOtherUserIds !== null
				: JSON.stringify(normalized) !== JSON.stringify(selectedOtherUserIds ?? []);

		if (!changed) {
			return;
		}

		selectedOtherUserIds = normalized;
		if (browser && roomId) {
			saveParticipantFilter(roomId, normalized);
		}
	}

	/** @param {string} participantId */
	function isParticipantSelected(participantId) {
		return (
			participantId === userId ||
			selectedOtherUserIds === null ||
			selectedOtherUserIds.includes(participantId)
		);
	}

	function resetParticipantFilter() {
		selectedOtherUserIds = null;
		saveParticipantFilter(roomId, null);
	}

	/** @param {string} participantId */
	function toggleParticipantFilter(participantId) {
		if (participantId === userId) {
			return;
		}

		const availableOtherUserIds = otherParticipants.map((selection) => selection.userId);
		const nextSelection = selectedOtherUserIds
			? [...selectedOtherUserIds]
			: [...availableOtherUserIds];
		const index = nextSelection.indexOf(participantId);
		if (index >= 0) {
			nextSelection.splice(index, 1);
		} else {
			nextSelection.push(participantId);
		}

		selectedOtherUserIds = normalizeSelectedOtherUserIds(nextSelection, availableOtherUserIds);
		saveParticipantFilter(roomId, selectedOtherUserIds);
	}

	/**
	 * @param {{ preferRemoteColor?: boolean }} [options]
	 */
	async function fetchSelections(options = {}) {
		if (!roomId || !userId) {
			return { remoteViewerFound: false, viewerColor: myColor };
		}

		try {
			const response = await fetch(`/api/stagehopper/rooms/${roomId}/selections`);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			/** @type {RoomSelection[]} */
			const data = await response.json();
			const merged = mergeSelectionsForViewer(
				data,
				{
					userId,
					name: myName,
					color: myColor,
					selections: mySelections
				},
				{ preferRemoteColor: options.preferRemoteColor }
			);
			mySelections = merged.viewerSelections;
			myColor = merged.viewerColor;
			allSelections = merged.allSelections;
			reconcileParticipantFilter();
			syncError = '';
			return {
				remoteViewerFound: merged.remoteViewerFound,
				viewerColor: merged.viewerColor
			};
		} catch {
			syncError = 'Sync failed. Retrying…';
			return { remoteViewerFound: false, viewerColor: myColor };
		}
	}

	async function flushPut() {
		if (!roomId || !userId || !myName) {
			return;
		}

		try {
			const response = await fetch(`/api/stagehopper/rooms/${roomId}/selections`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					participantKey: userId,
					name: myName,
					color: myColor,
					selections: mySelections
				})
			});
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			syncError = '';
		} catch {
			syncError = 'Save failed.';
		}
	}

	function schedulePut() {
		if (putTimer) clearTimeout(putTimer);
		putTimer = setTimeout(flushPut, 500);
	}

	function beginPolling(immediate = true) {
		if (pollInterval) clearInterval(pollInterval);
		if (immediate) {
			void fetchSelections();
		}
		pollInterval = setInterval(() => {
			void fetchSelections();
		}, 10000);
	}

	function haptic() {
		if (typeof navigator !== 'undefined' && navigator.vibrate) {
			navigator.vibrate(12);
		}
	}

	/** @param {string} color */
	function selectModalColor(color) {
		modalColor = color;
		modalColorDirty = true;
	}

	/** @param {string} performanceId */
	function handlePerfClick(performanceId) {
		if (showModal) return;
		const current = /** @type {0|1|2} */ (mySelections[performanceId] ?? 0);
		const next = cycleState(current);
		mySelections = { ...mySelections, [performanceId]: next };
		haptic();
		allSelections = allSelections.map((selection) =>
			selection.userId === userId ? { ...selection, selections: mySelections } : selection
		);
		schedulePut();
	}

	function handleAnonymousJoin() {
		const trimmedName = modalName.trim().slice(0, 50);
		if (!trimmedName) return;

		authMode = 'anonymous';
		userId = `anon:${crypto.randomUUID()}`;
		myName = trimmedName;
		myColor = modalColor;
		mySelections = {};
		saveAnonymousIdentity(roomId, userId, trimmedName, modalColor);
		allSelections = [{ userId, name: trimmedName, color: modalColor, selections: {} }];
		reconcileParticipantFilter();
		showModal = false;
		beginPolling();
		void flushPut();
	}

	function closeModal() {
		if (!authMode) return;
		showModal = false;
	}

	async function copyShareUrl() {
		try {
			await navigator.clipboard.writeText(window.location.href);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			// clipboard not available
		}
	}

	/** @type {number|null} */
	let touchStartX = null;
	/** @type {number|null} */
	let touchStartY = null;
	let touchStartScrollLeft = 0;
	let touchIsScroll = false;

	/** @param {TouchEvent} e */
	function handleTouchStart(e) {
		const touch = e.touches[0];
		touchStartX = touch.clientX;
		touchStartY = touch.clientY;
		touchStartScrollLeft = gridScrollEl?.scrollLeft ?? 0;
		touchIsScroll = false;
	}

	/** @param {TouchEvent} e */
	function handleTouchMove(e) {
		if (touchStartX === null || touchStartY === null) return;
		const dx = e.touches[0].clientX - touchStartX;
		const dy = e.touches[0].clientY - touchStartY;
		if (!touchIsScroll && Math.abs(dy) > Math.abs(dx) + 6) {
			touchIsScroll = true;
		}
	}

	/** @param {TouchEvent} e */
	function handleTouchEnd(e) {
		if (touchStartX === null || touchStartY === null || touchIsScroll) {
			touchStartX = null;
			touchStartY = null;
			return;
		}
		const dx = e.changedTouches[0].clientX - touchStartX;
		const dy = e.changedTouches[0].clientY - touchStartY;
		const maxScrollLeft = Math.max(
			0,
			(gridScrollEl?.scrollWidth ?? 0) - (gridScrollEl?.clientWidth ?? 0)
		);
		if (
			shouldTriggerDaySwipe({
				dx,
				dy,
				scrollLeftAtStart: touchStartScrollLeft,
				maxScrollLeft
			})
		) {
			currentDayIdx =
				(currentDayIdx + (dx < 0 ? 1 : -1) + timetable.days.length) % timetable.days.length;
			haptic();
		}
		touchStartX = null;
		touchStartY = null;
	}

	async function bootstrapRoom() {
		if (!browser) {
			return;
		}

		const rid = $page.params.roomId;
		roomId = rid;
		likedIds = loadLiked(rid);
		const storedRoomState = loadRoomState(rid);
		modalColor = storedRoomState.anonymousIdentity?.color ?? COLORS[0];
		modalColorDirty = false;
		selectedOtherUserIds = Array.isArray(storedRoomState.selectedOtherUserIds)
			? storedRoomState.selectedOtherUserIds
			: null;

		if (storedRoomState.anonymousIdentity) {
			authMode = 'anonymous';
			userId = storedRoomState.anonymousIdentity.userId;
			myName = storedRoomState.anonymousIdentity.name;
			myColor = storedRoomState.anonymousIdentity.color;
			modalName = myName;
			modalColor = myColor;
			showModal = false;
			beginPolling();
			return;
		}

		authMode = '';
		modalMode = 'join';
		showModal = true;
		modalColorDirty = false;
	}

	/**
	 * Return the index of today's date in the timetable, or 0 if outside festival dates.
	 * @param {Array<{date: string}>} days
	 */
	function getInitialDayIdx(days) {
		const today = new Date().toISOString().slice(0, 10);
		const idx = days.findIndex((d) => d.date === today);
		return idx >= 0 ? idx : 0;
	}

	function updateNow() {
		const now = new Date();
		nowMin = now.getHours() * 60 + now.getMinutes();
		// post-midnight: treat as next-day hours on the grid
		if (nowMin < GRID_START_MIN) nowMin += 1440;
	}

	onMount(() => {
		void bootstrapRoom();
		updateNow();
		nowIntervalId = setInterval(updateNow, 60000);
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/sw.js').catch(() => {});
		}
	});

	onDestroy(() => {
		if (pollInterval) clearInterval(pollInterval);
		if (putTimer) clearTimeout(putTimer);
		if (nowIntervalId) clearInterval(nowIntervalId);
	});
</script>

<svelte:head>
	<title>StageHopper – Room</title>
</svelte:head>

<div class="sh-room">
	<!-- Identity modal -->
	{#if showModal}
		<div class="modal-backdrop">
			<div class="modal-card">
				<h2>Join the room</h2>
				<p class="modal-sub">
					Enter your name and pick a colour so friends can identify your picks.
				</p>

				<label class="modal-label" for="modal-name">Your name</label>
				<input
					id="modal-name"
					type="text"
					bind:value={modalName}
					maxlength="50"
					placeholder="e.g. Alex"
					class="sh-input"
					onkeydown={(e) => e.key === 'Enter' && handleAnonymousJoin()}
				/>

				<fieldset class="color-fieldset">
					<legend class="modal-label">Your colour</legend>
					<div class="color-swatches">
						{#each COLORS as c}
							<button
								type="button"
								class="swatch"
								class:swatch-selected={modalColor === c}
								style="background: {c};"
								onclick={() => selectModalColor(c)}
								aria-label="Colour {c}"
							></button>
						{/each}
					</div>
				</fieldset>

				<button
					type="button"
					class="btn-primary btn-block"
					onclick={handleAnonymousJoin}
					disabled={!modalName.trim()}
				>
					Join
				</button>

				{#if authMode}
					<button type="button" class="btn-secondary btn-block" onclick={closeModal}>
						Cancel
					</button>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Nav bar -->
	<nav class="sh-nav">
		<span class="sh-brand">🎵 StageHopper</span>

		<div class="day-tabs">
			{#each timetable.days as day, i}
				<button
					class="tab"
					class:tab-active={currentDayIdx === i}
					onclick={() => (currentDayIdx = i)}
				>
					{day.label}
				</button>
			{/each}
		</div>

		<div class="nav-right">
			<button
				class="tab"
				class:tab-active={viewMode === 'full'}
				onclick={() => (viewMode = 'full')}
			>
				Timetable
			</button>
			<button
				class="tab"
				class:tab-active={viewMode === 'picks'}
				onclick={() => (viewMode = 'picks')}
			>
				Picks
			</button>
			<button
				class="tab"
				class:tab-active={viewMode === 'liked'}
				onclick={() => (viewMode = 'liked')}
			>
				♥ Liked
			</button>
			<button class="btn-sm" onclick={copyShareUrl}>
				{copied ? 'Copied!' : 'Share Room'}
			</button>
		</div>
	</nav>

	<!-- Legend / participants bar -->
	<div class="legend-bar">
		<!-- Swipe day indicator (mobile only) -->
		<div class="day-dots" aria-hidden="true">
			{#each timetable.days as _, i}
				<span class="day-dot" class:day-dot-active={currentDayIdx === i}></span>
			{/each}
		</div>
		<button
			type="button"
			class="legend-entry legend-entry-button legend-entry-all"
			class:legend-entry-active={showingAllParticipants}
			onclick={resetParticipantFilter}
		>
			<span class="legend-name legend-name-all">All</span>
		</button>
		{#each allSelections as sel}
			<button
				type="button"
				class="legend-entry legend-entry-button"
				class:legend-entry-active={isParticipantSelected(sel.userId)}
				class:legend-entry-me={sel.userId === userId}
				onclick={() => toggleParticipantFilter(sel.userId)}
				disabled={sel.userId === userId}
				aria-pressed={isParticipantSelected(sel.userId)}
			>
				<span class="legend-dot" style="background: {sel.color};"></span>
				<span class="legend-name" class:legend-me={sel.userId === userId}>
					{sel.name}{sel.userId === userId ? ' (you)' : ''}
				</span>
			</button>
		{/each}
	</div>

	{#if syncError || statusMessage}
		<div class="status-bar">
			{#if syncError}<span class="status-error">{syncError}</span>{/if}
			{#if statusMessage}<span class="status-msg">{statusMessage}</span>{/if}
		</div>
	{/if}

	<!-- Timetable grid -->
	{#if viewMode !== 'liked'}
		<div
			class="grid-scroll"
			bind:this={gridScrollEl}
			ontouchstart={handleTouchStart}
			ontouchmove={handleTouchMove}
			ontouchend={handleTouchEnd}
		>
			<div class="grid-inner">
				<!-- Time axis (sticky left) -->
				<div class="time-col" style="width: {TIME_COL_W}px;">
					<!-- Corner cell -->
					<div class="time-corner" style="height: {HEADER_H}px;"></div>
					<!-- Hour labels -->
					<div class="time-body" style="height: {GRID_HEIGHT}px;">
						{#each HOUR_MARKERS as marker}
							<div class="hour-line" style="top: {marker.top}px;"></div>
							<div class="hour-label" style="top: {marker.top}px;">{marker.label}</div>
						{/each}
						{#if nowVisible}
							<div class="now-line now-line-time" style="top: {nowTop}px;"></div>
						{/if}
					</div>
				</div>

				<!-- Stage columns -->
				{#each visibleStages as stageData}
					<div class="stage-col" style="width: {COL_WIDTH}px;">
						<!-- Stage header (sticky top) -->
						<div class="stage-header" style="height: {HEADER_H}px;" title={stageData.name}>
							{stageData.name}
						</div>

						<!-- Stage body -->
						<div class="stage-body" style="height: {GRID_HEIGHT}px;">
							<!-- Hour grid lines -->
							{#each HOUR_MARKERS as marker}
								<div class="stage-hour-line" style="top: {marker.top}px;"></div>
							{/each}
							{#if nowVisible}
								<div class="now-line" style="top: {nowTop}px;"></div>
							{/if}

							<!-- Performance blocks -->
							{#each stageData.performances as perf}
								{@const myState = mySelections[perf.id] ?? 0}
								{@const marks = getParticipantMarks(perf.id)}
								{@const top = timeToTop(perf.startTime)}
								{@const height = durationPx(perf.startTime, perf.endTime)}
								{@const selectionVisuals = getSelectionVisuals(myColor, myState)}
								<!-- svelte-ignore a11y_interactive_supports_focus -->
								<div
									class="perf-block"
									class:perf-unmarked={myState === 0}
									role="button"
									tabindex={showModal ? -1 : 0}
									style="top: {top}px; height: {height}px; background: {selectionVisuals.background}; border-color: {selectionVisuals.border};"
									onclick={() => handlePerfClick(perf.id)}
									onkeydown={(e) => e.key === 'Enter' && handlePerfClick(perf.id)}
								>
									<span class="perf-artist">{perf.artist}</span>
									{#if height > 28}
										<span class="perf-time">{perf.startTime}–{perf.endTime}</span>
									{/if}
									<!-- Friends' marks (dots) -->
									{#if marks.length > 0}
										<div class="perf-dots">
											{#each marks.filter((m) => m.userId !== userId) as mark}
												<span
													class="perf-dot"
													style="background: {colorWithOpacity(
														mark.color,
														mark.state === 2 ? 0.35 : 0.92
													)}; border-color: {colorWithOpacity(
														mark.color,
														mark.state === 2 ? 0.7 : 1
													)};"
													title={mark.name}
												>
													{getParticipantInitial(mark.name)}
												</span>
											{/each}
										</div>
									{/if}
									<button
										class="perf-heart"
										class:perf-heart-active={likedIds.has(perf.id)}
										onpointerup={(e) => { e.stopPropagation(); toggleLiked(perf.id); }}
										onclick={(e) => e.stopPropagation()}
										aria-label="Like"
										tabindex={showModal ? -1 : 0}
									>
										♥
									</button>
								</div>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	{#if viewMode === 'liked'}
		<div class="liked-view">
			{#if likedPerformances.length === 0}
				<p class="liked-empty">Tap ♥ on a performance to save it here.</p>
			{:else}
				{#each likedPerformances as p}
					<div class="liked-item">
						<div class="liked-item-artist">{p.artist}</div>
						<div class="liked-item-meta">{p.stage} · {p.startTime}–{p.endTime} · {p.dayLabel}</div>
					</div>
				{/each}
			{/if}
		</div>
	{/if}

	<!-- Mobile bottom nav -->
	<div class="mobile-bottom-bar">
		<button
			class="bottom-btn"
			class:bottom-btn-active={viewMode === 'full'}
			onclick={() => (viewMode = 'full')}
		>
			⊞ Timetable
		</button>
		<button
			class="bottom-btn"
			class:bottom-btn-active={viewMode === 'picks'}
			onclick={() => (viewMode = 'picks')}
		>
			★ Picks
		</button>
		<button
			class="bottom-btn"
			class:bottom-btn-active={viewMode === 'liked'}
			onclick={() => (viewMode = 'liked')}
		>
			♥ Liked
		</button>
		<button class="bottom-btn" onclick={copyShareUrl}>
			⎘ {copied ? 'Copied!' : 'Share Room'}
		</button>
	</div>
</div>

<style>
	/* Full-screen room container */
	.sh-room {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: rgba(18, 18, 18, 0.97);
		color: #fffaf0;
		pointer-events: auto;
	}

	/* Modal */
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
	}

	.modal-card h2 {
		margin: 0 0 0.4rem;
		font-size: 1.3rem;
		color: #fffaf0;
	}

	.modal-sub {
		color: #aaa;
		font-size: 0.85rem;
		margin: 0 0 1.5rem;
		line-height: 1.5;
	}

	.modal-label {
		display: block;
		font-size: 0.8rem;
		color: #ccc;
		margin-bottom: 0.4rem;
	}

	.color-fieldset {
		border: 0;
		padding: 0;
		margin: 1rem 0 0;
		min-width: 0;
	}

	.sh-input {
		width: 100%;
		background: #333;
		border: 1px solid #555;
		border-radius: 6px;
		color: #fffaf0;
		padding: 0.55rem 0.75rem;
		font-size: 0.95rem;
		box-sizing: border-box;
	}

	.sh-input:focus {
		outline: none;
		border-color: #e74c3c;
	}

	.color-swatches {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.swatch {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		border: 2px solid transparent;
		cursor: pointer;
		transition: border-color 0.1s;
	}

	.swatch-selected {
		border-color: #fff;
	}

	.btn-primary {
		background: #e74c3c;
		color: #fff;
		border: none;
		border-radius: 8px;
		padding: 0.7rem 1.5rem;
		font-size: 0.95rem;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.15s;
	}

	.btn-primary:hover:not(:disabled) {
		background: #c0392b;
	}

	.btn-primary:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.btn-block {
		margin-top: 1.5rem;
		width: 100%;
	}

	.btn-secondary {
		background: transparent;
		border: 1px solid #555;
		border-radius: 8px;
		color: #ddd;
		padding: 0.7rem 1.5rem;
		font-size: 0.95rem;
		font-weight: 600;
		cursor: pointer;
		transition:
			background 0.15s,
			border-color 0.15s;
	}

	.btn-secondary:hover {
		background: #2a2a2a;
		border-color: #777;
	}

	.modal-status,
	.error {
		font-size: 0.8rem;
		line-height: 1.5;
	}

	.modal-status {
		margin: 0.9rem 0 0;
		color: #ccc;
	}

	.error {
		color: #e74c3c;
		margin-top: 0.9rem;
	}

	/* Nav bar */
	.sh-nav {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0 0.75rem;
		height: 48px;
		background: #111;
		border-bottom: 1px solid #2d2d2d;
		flex-shrink: 0;
		overflow-x: auto;
		overflow-y: hidden;
	}

	.sh-brand {
		font-size: 0.9rem;
		font-weight: 700;
		color: #fffaf0;
		white-space: nowrap;
		margin-right: 0.5rem;
	}

	.day-tabs {
		display: flex;
		gap: 0.25rem;
	}

	.nav-right {
		display: flex;
		gap: 0.25rem;
		margin-left: auto;
	}

	.tab {
		background: transparent;
		border: 1px solid #444;
		border-radius: 6px;
		color: #aaa;
		padding: 0.3rem 0.7rem;
		font-size: 0.75rem;
		cursor: pointer;
		white-space: nowrap;
		transition:
			background 0.1s,
			color 0.1s;
	}

	.tab:hover {
		background: #2a2a2a;
		color: #eee;
	}

	.tab-active {
		background: #2a2a2a;
		border-color: #e74c3c;
		color: #fffaf0;
	}

	.btn-sm {
		background: transparent;
		border: 1px solid #444;
		border-radius: 6px;
		color: #aaa;
		padding: 0.3rem 0.7rem;
		font-size: 0.75rem;
		cursor: pointer;
		white-space: nowrap;
		transition:
			background 0.1s,
			color 0.1s;
	}

	.btn-sm:hover {
		background: #2a2a2a;
		color: #eee;
	}

	/* Legend bar */
	.legend-bar {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0 0.75rem;
		height: 34px;
		background: #111;
		border-bottom: 1px solid #2d2d2d;
		flex-shrink: 0;
		overflow-x: auto;
		overflow-y: hidden;
	}

	.legend-entry {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		white-space: nowrap;
	}

	.legend-entry-button {
		background: transparent;
		border: 1px solid #343434;
		border-radius: 999px;
		padding: 0.18rem 0.55rem;
		cursor: pointer;
		transition:
			background 0.12s,
			border-color 0.12s,
			opacity 0.12s;
	}

	.legend-entry-button:hover:not(:disabled) {
		background: #1e1e1e;
		border-color: #505050;
	}

	.legend-entry-button:disabled {
		cursor: default;
	}

	.legend-entry-active {
		background: #232323;
		border-color: #5b5b5b;
	}

	.legend-entry-all {
		padding-inline: 0.75rem;
	}

	.legend-entry-me {
		border-color: #5a4740;
	}

	.legend-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.legend-name {
		font-size: 0.75rem;
		color: #888;
	}

	.legend-name-all {
		color: #d2d2d2;
	}

	.legend-me {
		color: #fffaf0;
		font-weight: 600;
	}

	.status-bar {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0 0.75rem;
		min-height: 28px;
		background: #111;
		border-bottom: 1px solid #2d2d2d;
		flex-shrink: 0;
	}

	.status-error {
		font-size: 0.75rem;
		color: #e74c3c;
	}

	.status-msg {
		font-size: 0.75rem;
		color: #888;
		font-style: italic;
	}

	/* Day dots (swipe indicator) */
	.day-dots {
		display: none;
		gap: 5px;
		align-items: center;
		flex-shrink: 0;
	}

	.day-dot {
		display: block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #444;
		transition: background 0.2s;
	}

	.day-dot-active {
		background: #e74c3c;
	}

	@media (max-width: 767px) {
		.day-dots {
			display: flex;
		}
	}

	/* Grid scroll area */
	.grid-scroll {
		flex: 1;
		overflow: auto;
		position: relative;
	}

	/* Inner wrapper wide enough to hold all columns */
	.grid-inner {
		display: inline-flex;
		min-height: 100%;
	}

	/* Time axis — sticky to left */
	.time-col {
		position: sticky;
		left: 0;
		z-index: 15;
		background: #111;
		border-right: 1px solid #2d2d2d;
		flex-shrink: 0;
	}

	.time-corner {
		position: sticky;
		top: 0;
		background: #111;
		border-bottom: 1px solid #2d2d2d;
		z-index: 25;
	}

	.time-body {
		position: relative;
	}

	.hour-line {
		position: absolute;
		left: 0;
		right: 0;
		border-top: 1px solid #1e1e1e;
	}

	.hour-label {
		position: absolute;
		left: 2px;
		right: 2px;
		font-size: 0.6rem;
		color: #666;
		transform: translateY(-50%);
		white-space: nowrap;
	}

	/* Stage columns */
	.stage-col {
		flex-shrink: 0;
		border-right: 1px solid #1e1e1e;
	}

	.stage-header {
		position: sticky;
		top: 0;
		z-index: 10;
		background: #141414;
		border-bottom: 1px solid #2d2d2d;
		display: flex;
		align-items: center;
		padding: 0 6px;
		overflow: hidden;
		font-size: 0.6rem;
		color: #bbb;
		text-transform: uppercase;
		letter-spacing: 0.4px;
		line-height: 1.2;
	}

	.stage-body {
		position: relative;
	}

	.stage-hour-line {
		position: absolute;
		left: 0;
		right: 0;
		border-top: 1px solid #1c1c1c;
	}

	/* Performance blocks */
	.perf-block {
		position: absolute;
		left: 2px;
		right: 2px;
		border: 1px solid #3a3a3a;
		border-radius: 3px;
		padding: 2px 4px;
		overflow: hidden;
		cursor: pointer;
		box-sizing: border-box;
		transition: filter 0.1s;
	}

	.perf-block:hover {
		filter: brightness(1.15);
	}

	.perf-unmarked:hover {
		background: #2e2e2e !important;
	}

	.perf-artist {
		display: block;
		font-size: 0.65rem;
		font-weight: 700;
		color: #fffaf0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 1.25;
	}

	.perf-time {
		display: block;
		font-size: 0.55rem;
		color: #999;
		line-height: 1.2;
	}

	/* Friends' badges */
	.perf-dots {
		position: absolute;
		top: 2px;
		right: 2px;
		display: flex;
		gap: 3px;
		flex-wrap: wrap;
		justify-content: flex-end;
		max-width: 34px;
	}

	.perf-dot {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 1px solid transparent;
		box-sizing: border-box;
		color: #fffaf0;
		font-size: 0.48rem;
		font-weight: 700;
		line-height: 1;
		text-transform: uppercase;
		box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
	}

	.perf-heart {
		position: absolute;
		bottom: 2px;
		right: 2px;
		width: 28px;
		height: 28px;
		border-radius: 0;
		border: none;
		background: transparent;
		color: #555;
		font-size: 1.2rem;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		padding: 0;
		line-height: 1;
		transition:
			color 0.1s,
			border-color 0.1s;
		z-index: 2;
	}

	.perf-heart:hover { color: #e74c3c; }
	.perf-heart-active { color: #e74c3c; background: transparent; }

	.liked-view {
		flex: 1;
		overflow-y: auto;
		padding: 1rem 0.75rem;
	}

	.liked-empty {
		color: #666;
		font-size: 0.85rem;
		font-style: italic;
		text-align: center;
		margin-top: 2rem;
	}

	.liked-item {
		padding: 0.65rem 0;
		border-bottom: 1px solid #2a2a2a;
	}

	.liked-item-artist {
		font-size: 0.9rem;
		font-weight: 600;
		color: #fffaf0;
	}

	.liked-item-meta {
		font-size: 0.75rem;
		color: #777;
		margin-top: 0.15rem;
	}

	/* ====== Mobile Optimizations (< 768px) ====== */
	@media (max-width: 767px) {
		/* Reduce column widths for mobile */
		:global(:root) {
			--col-width: 100px;
			--time-col-w: 40px;
			--header-h: 40px;
		}

		.sh-room {
			font-size: 14px;
		}

		/* Modal adjustments */
		.modal-backdrop {
			padding: 0.5rem;
		}

		.modal-card {
			padding: 1.5rem;
			border-radius: 8px;
		}

		.modal-card h2 {
			font-size: 1.1rem;
			margin-bottom: 0.5rem;
		}

		.modal-sub {
			font-size: 0.8rem;
			margin-bottom: 1rem;
		}

		.modal-label {
			font-size: 0.75rem;
			margin-bottom: 0.3rem;
		}

		.sh-input {
			padding: 0.5rem 0.6rem;
			font-size: 16px; /* Prevents zoom on iOS */
			border-radius: 4px;
		}

		.color-swatches {
			gap: 0.4rem;
		}

		.swatch {
			width: 32px;
			height: 32px;
		}

		.btn-primary {
			padding: 0.6rem 1.2rem;
			font-size: 0.9rem;
			min-height: 44px; /* Touch target */
		}

		.btn-secondary {
			padding: 0.6rem 1.2rem;
			font-size: 0.9rem;
			min-height: 44px;
		}

		/* Navigation compacting */
		.sh-nav {
			padding: 0 0.5rem;
			height: 44px;
			gap: 0.3rem;
		}

		.sh-brand {
			font-size: 0.8rem;
			margin-right: 0.3rem;
		}

		.day-tabs {
			gap: 0.1rem;
		}

		.tab {
			padding: 0.25rem 0.5rem;
			font-size: 0.65rem;
			min-height: 32px;
			display: flex;
			align-items: center;
		}

		.btn-sm {
			padding: 0.25rem 0.5rem;
			font-size: 0.65rem;
			min-height: 32px;
			display: flex;
			align-items: center;
		}

		/* Legend bar compacting */
		.legend-bar {
			padding: 0 0.5rem;
			height: 32px;
			gap: 0.7rem;
		}

		.legend-entry {
			gap: 0.25rem;
		}

		.legend-name {
			font-size: 0.65rem;
		}

		.sync-error {
			font-size: 0.65rem;
		}

		.picks-empty {
			font-size: 0.65rem;
		}

		/* Grid sizing */
		.hour-label {
			font-size: 0.5rem;
			left: 1px;
			right: 1px;
		}

		.stage-header {
			padding: 0 3px;
			font-size: 0.5rem;
			line-height: 1.1;
		}

		/* Performance block text */
		.perf-artist {
			font-size: 0.6rem;
			line-height: 1.2;
		}

		.perf-time {
			font-size: 0.45rem;
		}

		.perf-block {
			left: 1px;
			right: 1px;
		}

		.perf-dots {
			top: 1px;
			right: 1px;
			max-width: 28px;
		}

		.perf-dot {
			width: 12px;
			height: 12px;
			font-size: 0.42rem;
		}
	}

	/* ====== Extra Small Devices (< 480px) ====== */
	@media (max-width: 479px) {
		:global(:root) {
			--col-width: 80px;
			--time-col-w: 35px;
		}

		.modal-card {
			padding: 1.25rem;
		}

		.modal-card h2 {
			font-size: 1rem;
		}

		.modal-sub {
			font-size: 0.75rem;
		}

		.sh-input {
			padding: 0.45rem 0.5rem;
			font-size: 16px;
		}

		.swatch {
			width: 28px;
			height: 28px;
		}

		.btn-primary {
			padding: 0.5rem 1rem;
			font-size: 0.85rem;
		}

		.sh-nav {
			padding: 0 0.4rem;
			height: 40px;
			gap: 0.2rem;
		}

		.sh-brand {
			font-size: 0.7rem;
			margin-right: 0.2rem;
		}

		.tab {
			padding: 0.2rem 0.4rem;
			font-size: 0.6rem;
			min-height: 30px;
		}

		.btn-sm {
			padding: 0.2rem 0.4rem;
			font-size: 0.6rem;
			min-height: 30px;
		}

		.legend-bar {
			padding: 0 0.4rem;
			height: 28px;
			gap: 0.5rem;
		}

		.legend-name {
			font-size: 0.6rem;
		}

		.stage-header {
			padding: 0 2px;
			font-size: 0.45rem;
		}

		.hour-label {
			font-size: 0.45rem;
		}

		.perf-artist {
			font-size: 0.55rem;
		}

		.perf-time {
			font-size: 0.4rem;
		}
	}

	/* Current time line */
	.now-line {
		position: absolute;
		left: 0;
		right: 0;
		height: 2px;
		background: repeating-linear-gradient(
			90deg,
			rgba(230, 120, 120, 0.45) 0%,
			rgba(230, 175, 120, 0.45) 14.3%,
			rgba(220, 220, 120, 0.45) 28.6%,
			rgba(130, 210, 130, 0.45) 42.9%,
			rgba(120, 175, 220, 0.45) 57.1%,
			rgba(150, 130, 210, 0.45) 71.4%,
			rgba(210, 120, 180, 0.45) 85.7%,
			rgba(230, 120, 120, 0.45) 100%
		);
		background-size: 140px 100%;
		animation: now-line-flow 12s linear infinite;
		z-index: 5;
		pointer-events: none;
	}

	@keyframes now-line-flow {
		from {
			background-position-x: 0;
		}
		to {
			background-position-x: 140px;
		}
	}

	.now-line-time {
		left: 0;
		right: 0;
	}

	/* Mobile bottom nav */
	.mobile-bottom-bar {
		display: none;
	}

	@media (max-width: 767px) {
		.nav-right {
			display: none;
		}

		.mobile-bottom-bar {
			display: flex;
			position: fixed;
			bottom: 0;
			left: 0;
			right: 0;
			height: 52px;
			background: #111;
			border-top: 1px solid #2d2d2d;
			z-index: 20;
			justify-content: space-around;
			align-items: center;
		}

		.grid-scroll {
			padding-bottom: 52px;
		}

		.bottom-btn {
			flex: 1;
			height: 100%;
			background: transparent;
			border: none;
			color: #888;
			font-size: 0.75rem;
			cursor: pointer;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 2px;
			transition: color 0.1s;
		}

		.bottom-btn:hover {
			color: #eee;
		}

		.bottom-btn-active {
			color: #e74c3c;
		}
	}

	/* ====== Landscape Mode ====== */
	@media (max-width: 767px) and (orientation: landscape) {
		.mobile-bottom-bar {
			display: none;
		}

		.nav-right {
			display: flex;
		}

		.grid-scroll {
			padding-bottom: 0;
			margin-left: 44px;
		}
		.sh-room {
			flex-direction: row;
		}

		.sh-nav {
			writing-mode: vertical-rl;
			transform: rotate(180deg);
			width: 44px;
			height: auto;
			padding: 0;
			flex-direction: column;
		}

		.sh-brand {
			display: none;
		}

		.day-tabs {
			flex-direction: column;
		}

		.nav-right {
			flex-direction: column;
		}

		.legend-bar {
			position: absolute;
			left: 44px;
			top: 0;
			width: auto;
			height: 44px;
			flex-direction: row;
			z-index: 12;
		}
	}
</style>
