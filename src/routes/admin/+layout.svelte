<script lang="ts">
	/**
	 * Admin shell: sidebar nav plus the gate.
	 *
	 * The bundle is static, so `checkAdmin` only decides what this shell draws — every
	 * admin API route re-verifies the caller itself and this layout cannot grant anything
	 * it renders. A non-admin (or signed-out visitor) is sent home rather than shown a
	 * denial screen, so the admin surface never renders even for an instant on their way out.
	 */
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { checkAdmin } from '$lib/stagehopper/api.js';
	import { ensureFreshGoogleAuth } from '$lib/stagehopper/auth.js';
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
	}

	const { children }: Props = $props();

	/** Nothing renders until this flips true, so a redirect never flashes admin chrome. */
	let granted = $state(false);

	const NAV_LINKS = [
		{ href: '/admin', label: 'Overview' },
		{ href: '/admin/festivals', label: 'Festivals' },
		{ href: '/admin/rooms', label: 'Rooms' },
		{ href: '/admin/users', label: 'Users' }
	];

	function isActive(href: string): boolean {
		return href === '/admin' ? page.url.pathname === href : page.url.pathname.startsWith(href);
	}

	onMount(async () => {
		const auth = await ensureFreshGoogleAuth();
		if (!auth || !(await checkAdmin(auth.idToken))) {
			void goto('/');
			return;
		}
		granted = true;
	});
</script>

<svelte:head>
	<title>Admin · StageHopper</title>
	<meta name="robots" content="noindex" />
</svelte:head>

{#if granted}
	<div class="admin-shell">
		<nav class="admin-nav">
			<a class="admin-brand" href="/">StageHopper</a>
			<ul>
				{#each NAV_LINKS as link (link.href)}
					<li>
						<a href={link.href} class:active={isActive(link.href)}>{link.label}</a>
					</li>
				{/each}
			</ul>
		</nav>
		<main class="admin-content">
			{@render children()}
		</main>
	</div>
{/if}

<style>
	.admin-shell {
		display: flex;
		min-height: 100vh;
	}

	.admin-nav {
		width: 200px;
		flex-shrink: 0;
		background: #161616;
		border-right: 1px solid #2a2a2a;
		padding: 1rem 0;
		display: flex;
		flex-direction: column;
	}

	.admin-brand {
		display: block;
		padding: 0 1.25rem 1rem;
		margin-bottom: 0.5rem;
		border-bottom: 1px solid #2a2a2a;
		color: #fffaf0;
		font-weight: 700;
		font-size: 0.9rem;
		text-decoration: none;
	}

	.admin-nav ul {
		list-style: none;
		margin: 0;
		padding: 0.5rem 0 0;
	}

	.admin-nav a {
		display: block;
		padding: 0.5rem 1.25rem;
		color: #aaa;
		font-size: 0.85rem;
		text-decoration: none;
	}

	.admin-nav a:hover {
		color: #fffaf0;
		background: #1e1e1e;
	}

	.admin-nav a.active {
		color: #fffaf0;
		background: #262626;
		border-right: 2px solid #e74c3c;
	}

	.admin-content {
		flex: 1;
		min-width: 0;
		padding: 1.5rem 2rem;
	}
</style>
