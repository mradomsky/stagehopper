<script lang="ts">
	import { onMount } from 'svelte';
	import { getParticipantInitial, markDotStyle } from '../selections.js';
	import type { ParticipantMark } from '../types.js';

	interface Props {
		marks: ParticipantMark[];
		/** The tapped pill's on-screen position, used to anchor the popover next to it. */
		anchorRect: DOMRect;
		onClose: () => void;
	}

	const { marks, anchorRect, onClose }: Props = $props();

	const POPOVER_WIDTH = 220;
	const MARGIN = 8;

	/** Stays anchored to where the pill was tapped; doesn't track it live if the page moves. */
	const style = $derived.by(() => {
		const left = Math.min(
			Math.max(MARGIN, anchorRect.left),
			window.innerWidth - POPOVER_WIDTH - MARGIN
		);
		const spaceBelow = window.innerHeight - anchorRect.bottom;
		const openBelow = spaceBelow > 200 || spaceBelow > anchorRect.top;
		const vertical = openBelow
			? `top: ${anchorRect.bottom + MARGIN}px;`
			: `bottom: ${window.innerHeight - anchorRect.top + MARGIN}px;`;
		return `left: ${left}px; width: ${POPOVER_WIDTH}px; ${vertical}`;
	});

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') onClose();
	}

	// A non-bubbling scroll on the timetable's own scroll container still reaches window
	// during the capture phase, which is what lets one listener cover it without a ref.
	onMount(() => {
		window.addEventListener('scroll', onClose, true);
		return () => window.removeEventListener('scroll', onClose, true);
	});
</script>

<svelte:window onkeydown={handleKeydown} onresize={onClose} />

<div class="attendees-catcher" onclick={onClose} role="presentation"></div>
<div class="attendees-popover" style={style} role="dialog" aria-label="Who's going">
	<div class="attendees-popover-header">
		<span>Who's going</span>
		<button class="attendees-popover-close" onclick={onClose} aria-label="Close">✕</button>
	</div>
	<ul class="attendees-popover-list">
		{#each marks as mark (mark.userId)}
			{@const dot = markDotStyle(mark)}
			<li class="attendees-popover-item">
				<span
					class="attendees-popover-dot"
					style="background: {dot.background}; border-color: {dot.border};"
				>
					{getParticipantInitial(mark.name)}
				</span>
				<span class="attendees-popover-name">{mark.name}</span>
			</li>
		{/each}
	</ul>
</div>

<style>
	.attendees-catcher {
		position: fixed;
		inset: 0;
		z-index: 65;
	}

	.attendees-popover {
		position: fixed;
		z-index: 66;
		max-height: 260px;
		display: flex;
		flex-direction: column;
		background: #232323;
		border: 1px solid #444;
		border-radius: 10px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
		overflow: hidden;
	}

	.attendees-popover-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.6rem 0.5rem 0.6rem 0.85rem;
		border-bottom: 1px solid #333;
		color: #ddd;
		font-size: 0.8rem;
		font-weight: 600;
		flex-shrink: 0;
	}

	.attendees-popover-close {
		width: 26px;
		height: 26px;
		border: none;
		border-radius: 50%;
		background: transparent;
		color: #999;
		font-size: 0.8rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	@media (hover: hover) and (pointer: fine) {
		.attendees-popover-close:hover {
			background: #333;
			color: #fffaf0;
		}
	}

	.attendees-popover-list {
		list-style: none;
		margin: 0;
		padding: 0.4rem;
		overflow-y: auto;
	}

	.attendees-popover-item {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.35rem 0.4rem;
		border-radius: 6px;
	}

	.attendees-popover-dot {
		flex-shrink: 0;
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
	}

	.attendees-popover-name {
		font-size: 0.82rem;
		color: #fffaf0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
