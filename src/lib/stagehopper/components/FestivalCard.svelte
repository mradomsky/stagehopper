<script lang="ts">
	import { roomPath } from '../rooms.js';
	import type { Festival } from '../types.js';

	interface Props {
		festival: Festival;
		/** True while this festival's room is being created. */
		creating?: boolean;
		/** Disables the action while any room is being created. */
		disabled?: boolean;
		onCreateRoom: () => void;
	}

	const { festival, creating = false, disabled = false, onCreateRoom }: Props = $props();
</script>

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
			<a class="sh-btn sh-btn-secondary card-action" href={roomPath(festival.id)}>Browse</a>
			<button
				type="button"
				class="sh-btn sh-btn-primary card-action"
				onclick={onCreateRoom}
				disabled={disabled || creating}
			>
				{creating ? 'Creating…' : 'Create room'}
			</button>
		</div>
	</div>
</div>

<style>
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

	.card-action {
		flex: 1;
		padding: 0.55rem 0.8rem;
		font-size: 0.85rem;
	}
</style>
