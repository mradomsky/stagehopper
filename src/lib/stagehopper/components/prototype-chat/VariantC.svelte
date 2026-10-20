<!-- PROTOTYPE C — "Live feed over the timetable". Chat is ambient: new lines float up over
     the grid for a few seconds, a one-line compose bar is always there. Tapping the bar
     opens the full thread as an overlay; the timetable never gives up its space. -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import ChatThread from './ChatThread.svelte';
	import { PROTO_HERE_COUNT, type ProtoMessage } from './fixtures.js';

	interface Props {
		messages: ProtoMessage[];
		unread: number;
		onSend: (text: string) => void;
		timetable: Snippet;
	}
	const { messages, unread, onSend, timetable }: Props = $props();
	export const name = 'Live feed overlay';

	let open = $state(false);
	const TOAST_MS = 7000;
	const MAX_TOASTS = 3;
	/** Ids of messages still floating; each one expires on its own timer. */
	let floating = $state<string[]>([]);
	let seen = $state(messages.length);

	$effect(() => {
		if (messages.length <= seen) return;
		for (const m of messages.slice(seen)) {
			floating = [...floating, m.id].slice(-MAX_TOASTS);
			setTimeout(() => (floating = floating.filter((id) => id !== m.id)), TOAST_MS);
		}
		seen = messages.length;
	});

	const toasts = $derived(floating.map((id) => messages.find((m) => m.id === id)!));
</script>

<div class="stack">
	{@render timetable()}

	{#if !open}
		<div class="feed" aria-live="polite">
			{#each toasts as m (m.id)}
				<div class="toast">
					<b style="color: {m.color}">{m.handle}</b> {m.text}
				</div>
			{/each}
		</div>
		<button class="bar" onclick={() => (open = true)}>
			<span class="icon">💬</span>
			<span class="prompt">Say something to {PROTO_HERE_COUNT} people here…</span>
			{#if unread}<span class="badge">{unread}</span>{/if}
		</button>
	{:else}
		<div class="overlay">
			<div class="overlay-head">
				<span>💬 Festival chat · {PROTO_HERE_COUNT} here</span>
				<button class="sh-btn-sm" onclick={() => (open = false)}>✕ Back to timetable</button>
			</div>
			<div class="overlay-body"><ChatThread {messages} {onSend} /></div>
		</div>
	{/if}
</div>

<style>
	.stack {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		position: relative;
	}
	.feed {
		position: absolute;
		left: 0.75rem;
		bottom: 56px;
		max-width: min(420px, 80%);
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		pointer-events: none;
		z-index: 12;
	}
	.toast {
		background: rgba(30, 30, 30, 0.92);
		border: 1px solid #444;
		border-radius: 8px;
		padding: 0.35rem 0.6rem;
		font-size: 0.8rem;
		animation: rise 0.25s ease-out;
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
	}
	.bar {
		position: absolute;
		left: 0.75rem;
		right: 0.75rem;
		bottom: 0.5rem;
		height: 42px;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0 0.75rem;
		background: #2a2a2a;
		border: 1px solid #555;
		border-radius: 999px;
		color: #aaa;
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
		z-index: 12;
	}
	.prompt {
		flex: 1;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.badge {
		background: #e74c3c;
		color: #fff;
		border-radius: 999px;
		font-size: 0.65rem;
		padding: 0 0.35rem;
	}
	.overlay {
		position: absolute;
		inset: 0;
		background: rgba(18, 18, 18, 0.97);
		display: flex;
		flex-direction: column;
		z-index: 14;
	}
	.overlay-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid #2d2d2d;
		font-size: 0.85rem;
		font-weight: 600;
	}
	.overlay-body {
		flex: 1;
		min-height: 0;
	}
	@media (max-width: 767px) {
		.bar {
			bottom: 60px;
		}
		.feed {
			bottom: 110px;
		}
		.overlay {
			bottom: 52px;
		}
	}
</style>
