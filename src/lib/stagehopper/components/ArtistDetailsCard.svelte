<script lang="ts">
	import BellIcon from './BellIcon.svelte';
	import { colorWithOpacity, getParticipantInitial } from '../selections.js';
	import type { Artist, ParticipantMark, Performance, SelectionState } from '../types.js';

	interface Props {
		performance: Performance;
		stageName?: string;
		/** The viewer's going/maybe mark; drives the star and the pill. */
		state?: SelectionState;
		/** Other participants who marked this performance, shown as coloured badges. */
		marks?: ParticipantMark[];
		/** Cycle the viewer's mark. Omit to hide the star control. */
		onToggleMark?: () => void;
		/** Whether this set would notify — the bell's on/off state. */
		notifyOn?: boolean;
		/** Whether push is on for this account at all. Off shows a muted bell that offers setup. */
		notificationsAvailable?: boolean;
		/**
		 * Flip this set's notification bell, or (when push is off entirely) offer to turn it
		 * on. Omit to hide the bell — it's only shown once the set is marked (see {@link state}).
		 */
		onToggleNotify?: () => void;
		/** Expand the attendee pill into the full avatars-and-names popover. Omit to render
		 *  the pill as a plain, non-interactive row. */
		onOpenAttendees?: (marks: ParticipantMark[], anchorRect: DOMRect) => void;
		onClose: () => void;
	}

	const {
		performance,
		stageName = '',
		state = 0,
		marks = [],
		onToggleMark,
		notifyOn = false,
		notificationsAvailable = false,
		onToggleNotify,
		onOpenAttendees,
		onClose
	}: Props = $props();

	const markLabel = $derived(
		state === 0 ? 'Mark as going' : state === 1 ? 'Marked as going' : 'Marked as maybe'
	);
	/** Always the same bright gold when marked — no more per-participant colour. */
	const starStyle = $derived(state > 0 ? 'color: #ffd700; border-color: #ffd700;' : '');

	const bellLabel = $derived(
		state === 0
			? 'Mark as going or maybe to enable notifications for this set'
			: !notificationsAvailable
				? 'Notifications are off for your account — tap to turn them on'
				: notifyOn
					? 'Notifications on for this set — tap to mute'
					: 'Notifications off for this set — tap to enable'
	);

	/** Social links, in the order they are offered. */
	const LINK_FIELDS = [
		{ key: 'instagram', label: 'Instagram' },
		{ key: 'spotify', label: 'Spotify' },
		{ key: 'website', label: 'Website' },
		{ key: 'youtube', label: 'YouTube' },
		{ key: 'facebook', label: 'Facebook' },
		{ key: 'tiktok', label: 'TikTok' },
		{ key: 'soundcloud', label: 'SoundCloud' },
		{ key: 'twitter', label: 'Twitter' }
	] as const satisfies ReadonlyArray<{ key: keyof Artist; label: string }>;

	const firstArtist = $derived(performance.artists?.[0] ?? null);
	const image = $derived(firstArtist?.image ?? performance.artistImage ?? null);
	const bio = $derived(firstArtist?.bio ?? null);
	const genres = $derived(firstArtist?.genres ?? []);

	const links = $derived.by(() => {
		if (firstArtist) {
			return LINK_FIELDS.filter((field) => firstArtist[field.key]).map((field) => ({
				key: field.key,
				label: field.label,
				url: String(firstArtist[field.key])
			}));
		}
		const PERFORMANCE_LINK_FIELDS = [
			{ key: 'instagram', label: 'Instagram' },
			{ key: 'spotify', label: 'Spotify' },
			{ key: 'youtube', label: 'YouTube' },
			{ key: 'soundcloud', label: 'SoundCloud' }
		] as const satisfies ReadonlyArray<{ key: keyof Performance; label: string }>;
		return PERFORMANCE_LINK_FIELDS.filter((field) => performance[field.key]).map((field) => ({
			key: field.key,
			label: field.label,
			url: String(performance[field.key])
		}));
	});

	function handleBackdropClick(event: MouseEvent) {
		if (event.target === event.currentTarget) onClose();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') onClose();
	}

	function openAttendees(event: MouseEvent) {
		if (!onOpenAttendees) return;
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		onOpenAttendees(marks, rect);
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="details-backdrop" onclick={handleBackdropClick} role="presentation">
	<div class="details-card" role="dialog" aria-modal="true" aria-label={performance.artist}>
		<button class="details-close" onclick={onClose} aria-label="Close">✕</button>

		<div class="details-photo" class:details-photo-placeholder={!image}>
			{#if image}
				<img class="details-photo-bg" src={image} alt="" aria-hidden="true" />
				<img class="details-photo-fg" src={image} alt={performance.artist} />
			{:else}
				<span aria-hidden="true">🎤</span>
			{/if}
			{#if state > 0}
				<span class="details-selection">{state === 1 ? 'attending' : 'maybe'}</span>
			{/if}
		</div>

		<div class="details-body">
			<div class="details-heading">
				<div class="details-heading-text">
					<h2 class="details-name">{performance.artist}</h2>
					<p class="details-meta">
						{stageName}{stageName ? ' · ' : ''}{performance.startTime}–{performance.endTime}
					</p>
				</div>
				{#if onToggleMark || onToggleNotify}
					<div class="details-actions">
						{#if onToggleMark}
							<button
								class="details-action details-star"
								class:details-star-on={state > 0}
								style={starStyle}
								onclick={onToggleMark}
								aria-label={markLabel}
								title={markLabel}
							>
								{state > 0 ? '★' : '☆'}
							</button>
						{/if}
						{#if onToggleNotify}
							<button
								class="details-action details-bell"
								class:details-bell-on={notifyOn}
								class:details-bell-muted={!notificationsAvailable}
								disabled={state === 0}
								onclick={onToggleNotify}
								aria-label={bellLabel}
								title={bellLabel}
							>
								<BellIcon filled={notifyOn} />
							</button>
						{/if}
					</div>
				{/if}
			</div>

			{#if marks.length > 0}
				<svelte:element
					this={onOpenAttendees ? 'button' : 'div'}
					class="details-marks"
					class:details-marks-clickable={onOpenAttendees}
					role={onOpenAttendees ? 'button' : undefined}
					onclick={onOpenAttendees ? openAttendees : undefined}
					aria-label={onOpenAttendees ? `${marks.length} going — tap for names` : undefined}
				>
					{#each marks as mark (mark.userId)}
						<span
							class="details-mark"
							style="background: {colorWithOpacity(
								mark.color,
								mark.state === 2 ? 0.35 : 0.92
							)}; border-color: {colorWithOpacity(mark.color, mark.state === 2 ? 0.7 : 1)};"
							title={mark.name}
						>
							{getParticipantInitial(mark.name)}
						</span>
					{/each}
				</svelte:element>
			{/if}

			{#if genres.length > 0}
				<div class="details-genres">
					{#each genres as genre (genre)}
						<span class="details-genre">{genre}</span>
					{/each}
				</div>
			{/if}

			{#if bio}
				<p class="details-bio">{bio}</p>
			{/if}

			{#if links.length > 0}
				<div class="details-links">
					{#each links as link (link.key)}
						<a class="details-link" href={link.url} target="_blank" rel="noopener noreferrer">
							{link.label}
						</a>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.details-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.75);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 60;
		padding: 1rem;
	}

	.details-card {
		position: relative;
		background: #232323;
		border: 1px solid #444;
		border-radius: 12px;
		max-width: 420px;
		width: 100%;
		max-height: 85vh;
		overflow-y: auto;
	}

	.details-close {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		border: none;
		background: rgba(0, 0, 0, 0.5);
		color: #fffaf0;
		font-size: 0.9rem;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		/* Above the photo's foreground/backdrop layers (z-index 1/0) so it stays clickable. */
		z-index: 2;
	}

	.details-photo {
		position: relative;
		display: block;
		width: 100%;
		height: 220px;
		overflow: hidden;
		background: #1a1a1a;
		border-radius: 12px 12px 0 0;
	}

	/* Full artist photo, uncropped; the letterbox space is filled by the blurred layer. */
	.details-photo-fg {
		position: relative;
		z-index: 1;
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
	}

	.details-photo-bg {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		filter: blur(24px) saturate(1.2);
		transform: scale(1.2);
	}

	.details-photo-placeholder {
		background: linear-gradient(135deg, #3a3a3a, #1a1a1a);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 3rem;
	}

	.details-body {
		padding: 1.25rem 1.5rem 1.5rem;
	}

	.details-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.details-heading-text {
		min-width: 0;
	}

	.details-name {
		margin: 0 0 0.3rem;
		font-size: 1.3rem;
		color: #fffaf0;
	}

	.details-meta {
		margin: 0;
		color: #aaa;
		font-size: 0.85rem;
	}

	.details-actions {
		display: flex;
		flex-shrink: 0;
		gap: 0.5rem;
	}

	.details-action {
		width: 44px;
		height: 44px;
		border-radius: 50%;
		border: 1px solid #444;
		background: #2c2c2c;
		color: #888;
		font-size: 1.35rem;
		line-height: 1;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition:
			color 0.12s,
			border-color 0.12s;
	}

	.details-action:disabled {
		opacity: 0.35;
		cursor: default;
	}

	@media (hover: hover) and (pointer: fine) {
		.details-star:not(.details-star-on):hover {
			color: #f1c40f;
			border-color: #f1c40f;
		}
	}

	.details-bell {
		filter: grayscale(1);
		opacity: 0.45;
	}

	.details-bell-on {
		filter: none;
		opacity: 1;
		color: #ffd700;
		border-color: #ffd700;
	}

	.details-bell-muted {
		filter: grayscale(1);
		opacity: 0.3;
	}

	/* Going/maybe badge, overlaid on the photo's top-left corner like the festival
	   page's hero badge. */
	.details-selection {
		position: absolute;
		top: 0.7rem;
		left: 0.7rem;
		z-index: 2;
		padding: 0.2rem 0.65rem;
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.55);
		border: 1px solid rgba(255, 255, 255, 0.25);
		color: #fffaf0;
		font-size: 0.7rem;
		line-height: 1.4;
		backdrop-filter: blur(2px);
	}

	/* Coloured badges of the other participants going, in a wrapping row. */
	.details-marks {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-bottom: 1rem;
		border: none;
		background: transparent;
		padding: 0;
	}

	.details-marks-clickable {
		cursor: pointer;
	}

	@media (hover: hover) and (pointer: fine) {
		.details-marks-clickable:hover .details-mark {
			filter: brightness(1.15);
		}
	}

	.details-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		border: 1px solid transparent;
		color: #fffaf0;
		font-size: 0.7rem;
		font-weight: 700;
		line-height: 1;
		text-transform: uppercase;
		box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
	}

	.details-genres {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-bottom: 1rem;
	}

	.details-genre {
		border-radius: 999px;
		padding: 0.2rem 0.7rem;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: #ffd; /* soft cream */
		background: #3a3a2c;
		border: 1px solid #55552c;
	}

	.details-bio {
		margin: 0 0 1rem;
		color: #ccc;
		font-size: 0.85rem;
		line-height: 1.5;
		white-space: pre-line;
	}

	.details-links {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.details-link {
		border: 1px solid #555;
		border-radius: 999px;
		padding: 0.35rem 0.85rem;
		font-size: 0.75rem;
		color: #fffaf0;
		text-decoration: none;
		background: #2c2c2c;
	}

	.details-link:hover {
		border-color: #e74c3c;
	}

	@media (max-width: 767px) {
		.details-backdrop {
			align-items: flex-end;
			padding: 0;
		}

		.details-card {
			max-width: none;
			max-height: 85vh;
			border-radius: 16px 16px 0 0;
			animation: details-slide-up 0.22s ease-out;
		}

		.details-photo {
			border-radius: 16px 16px 0 0;
		}
	}

	@keyframes details-slide-up {
		from {
			transform: translateY(100%);
		}
		to {
			transform: translateY(0);
		}
	}
</style>
