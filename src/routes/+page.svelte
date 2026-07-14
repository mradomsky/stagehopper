<script>
	import { goto } from '$app/navigation';
	import { FESTIVALS } from '$lib/stagehopper/festivals.js';

	let creating = false;
	let errorMsg = '';
	let selectedFestivalId = FESTIVALS.find((f) => !f.past)?.id || FESTIVALS[0].id;

	function generateRoomId(prefix) {
		const randomHex = Math.floor(Math.random() * 16777216)
			.toString(16)
			.padStart(6, '0');
		return `${prefix}${randomHex}`;
	}

	async function createRoom() {
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
</script>

<svelte:head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<meta name="description" content="StageHopper – plan festivals with your friends." />
	<title>StageHopper</title>
</svelte:head>

<div class="overlay">
	<div class="card">
		<div class="logo">🎵</div>
		<h1>StageHopper</h1>
		<p class="tagline">
			Plan your festival days with friends. Pick a festival, create a shared room, mark your
			must-sees, and see everyone's picks live.
		</p>

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
		margin: 0 0 2rem;
	}

	.festival-list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-bottom: 2rem;
		text-align: left;
	}

	.festival-item {
		padding: 1rem;
		border: 2px solid #333;
		border-radius: 8px;
		background: rgba(40, 40, 40, 0.6);
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
			margin-bottom: 1.5rem;
			line-height: 1.5;
		}

		.festival-list {
			gap: 0.5rem;
			margin-bottom: 1.5rem;
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


