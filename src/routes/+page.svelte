<script>
	import { goto } from '$app/navigation';

	let creating = false;
	let errorMsg = '';

	async function createRoom() {
		creating = true;
		errorMsg = '';
		try {
			const resp = await fetch('/api/stagehopper/rooms', { method: 'POST' });
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const { roomId } = await resp.json();
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
	<meta name="description" content="StageHopper – plan Primavera Sound 2026 with your friends." />
	<title>StageHopper – Primavera Sound 2026</title>
</svelte:head>

<div class="overlay">
	<div class="card">
		<div class="logo">🎵</div>
		<h1>StageHopper</h1>
		<p class="festival">Primavera Sound Barcelona 2026 · June 4–6</p>
		<p class="tagline">
			Plan your festival days with friends. Create a shared room, mark your must-sees, and see
			everyone's picks live.
		</p>
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
		margin: 0 0 0.5rem;
		color: #fffaf0;
	}

	.festival {
		font-size: 0.85rem;
		color: #aaa;
		margin: 0 0 1.5rem;
	}

	.tagline {
		font-size: 0.95rem;
		color: #ccc;
		line-height: 1.6;
		margin: 0 0 2rem;
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
			margin-bottom: 0.3rem;
		}

		.festival {
			font-size: 0.8rem;
			margin-bottom: 1rem;
		}

		.tagline {
			font-size: 0.85rem;
			margin-bottom: 1.5rem;
			line-height: 1.5;
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
			margin-bottom: 0.25rem;
		}

		.festival {
			font-size: 0.75rem;
			margin-bottom: 0.75rem;
		}

		.tagline {
			font-size: 0.8rem;
			margin-bottom: 1.25rem;
		}

		.btn-primary {
			padding: 0.6rem 1.25rem;
			font-size: 0.9rem;
		}
	}
</style>


