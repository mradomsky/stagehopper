<script lang="ts">
	import { getFestivalByPrefix } from '../festivals.svelte.js';
	import type { RoomMembership } from '../types.js';

	interface Props {
		rooms: RoomMembership[];
		onOpen: (roomId: string) => void;
		/** Omit to hide the leave button, e.g. where this list is just a jump-back-in shortcut. */
		onLeave?: (roomId: string) => void;
	}

	const { rooms, onOpen, onLeave }: Props = $props();

	/** Custom rooms have no festival, so fall back to showing the raw id. */
	function roomLabel(roomId: string): string {
		return getFestivalByPrefix(roomId)?.name ?? roomId;
	}

	function roomIsPast(roomId: string): boolean {
		return getFestivalByPrefix(roomId)?.past ?? false;
	}
</script>

<div class="my-rooms">
	{#each rooms as room (room.roomId)}
		<div class="my-room-item">
			<button type="button" class="my-room-btn" onclick={() => onOpen(room.roomId)}>
				<span class="my-room-swatch" style="background:{room.color}"></span>
				<span class="my-room-label">
					{roomLabel(room.roomId)}
					{#if roomIsPast(room.roomId)}
						<span class="badge-past">(Past)</span>
					{/if}
				</span>
			</button>
			{#if onLeave}
				<button
					type="button"
					class="my-room-remove"
					aria-label="Leave {roomLabel(room.roomId)}"
					onclick={() => onLeave(room.roomId)}
				>
					✕
				</button>
			{/if}
		</div>
	{/each}
</div>

<style>
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
		transition:
			background 0.15s,
			border-color 0.15s;
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
		transition:
			color 0.15s,
			border-color 0.15s;
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
</style>
