<script lang="ts">
	interface MenuItem {
		label: string;
		onSelect: () => void;
	}

	interface Props {
		items: MenuItem[];
		/** `nav` drops down from the top bar, `bottom` drops up from the mobile bar. */
		variant?: 'nav' | 'bottom';
	}

	const { items, variant = 'nav' }: Props = $props();

	let open = $state(false);
	let wrapEl = $state<HTMLDivElement | null>(null);

	function handleWindowClick(event: MouseEvent) {
		if (!open) return;
		if (!wrapEl?.contains(event.target as Node)) open = false;
	}

	function select(item: MenuItem) {
		open = false;
		item.onSelect();
	}
</script>

<svelte:window onclick={handleWindowClick} />

<div class="menu-wrap" class:menu-wrap-bottom={variant === 'bottom'} bind:this={wrapEl}>
	<button
		class={variant === 'bottom' ? 'bottom-btn' : 'btn-sm'}
		onclick={() => (open = !open)}
		aria-label="More options"
		aria-expanded={open}
	>
		{variant === 'bottom' ? '⋮ More' : '⋮'}
	</button>

	{#if open}
		<div class="menu-dropdown" class:menu-dropdown-up={variant === 'bottom'}>
			{#each items as item (item.label)}
				<button type="button" onclick={() => select(item)}>{item.label}</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.menu-wrap {
		position: relative;
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

	@media (hover: hover) and (pointer: fine) {
		.btn-sm:hover {
			background: #2a2a2a;
			color: #eee;
		}
	}

	.menu-dropdown {
		position: absolute;
		top: calc(100% + 4px);
		right: 0;
		display: flex;
		flex-direction: column;
		min-width: 140px;
		background: #1c1c1c;
		border: 1px solid #3a3a3a;
		border-radius: 8px;
		overflow: hidden;
		z-index: 30;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
	}

	.menu-dropdown button {
		background: transparent;
		border: none;
		color: #eee;
		font-size: 0.8rem;
		text-align: left;
		padding: 0.6rem 0.85rem;
		cursor: pointer;
		white-space: nowrap;
	}

	@media (hover: hover) and (pointer: fine) {
		.menu-dropdown button:hover {
			background: #2a2a2a;
		}
	}

	.menu-dropdown button + button {
		border-top: 1px solid #333;
	}

	/* Bottom-bar variant: full-height trigger, dropdown opens upwards. */
	.menu-wrap-bottom {
		flex: 1;
		height: 100%;
		display: flex;
	}

	.menu-dropdown-up {
		top: auto;
		bottom: calc(100% + 6px);
		right: 0.25rem;
	}

	.bottom-btn {
		width: 100%;
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

	@media (hover: hover) and (pointer: fine) {
		.bottom-btn:hover {
			color: #eee;
		}
	}

	@media (max-width: 767px) {
		.btn-sm {
			padding: 0.25rem 0.5rem;
			font-size: 0.65rem;
			min-height: 32px;
			display: flex;
			align-items: center;
		}
	}

	@media (max-width: 479px) {
		.btn-sm {
			padding: 0.2rem 0.4rem;
			font-size: 0.6rem;
			min-height: 30px;
		}
	}
</style>
