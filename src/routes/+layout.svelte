<script>
	import '../app.css';
	const commit = import.meta.env.VITE_COMMIT ?? 'dev';
</script>

<slot />

<footer>
	<a href="https://github.com/mradomsky/stagehopper/commit/{commit}" target="_blank" rel="noopener">{commit}</a>
</footer>

<style>
	footer {
		position: fixed;
		bottom: 0.5rem;
		right: 0.75rem;
		font-size: 0.7rem;
		color: #555;
		pointer-events: auto;
	}

	footer a {
		color: inherit;
		text-decoration: none;
	}

	footer a:hover {
		color: #888;
	}
</style>
