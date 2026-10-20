<!-- PROTOTYPE — throwaway. Message list + compose box shared by the variants; the layout
     around it is what each variant changes. State is in memory only. -->
<script lang="ts">
	import { tick } from 'svelte';
	import type { ProtoMessage } from './fixtures.js';

	interface Props {
		messages: ProtoMessage[];
		onSend: (text: string) => void;
		/** Dense rows for narrow panels. */
		compact?: boolean;
		signedIn?: boolean;
	}

	const { messages, onSend, compact = false, signedIn = true }: Props = $props();

	let draft = $state('');
	let list = $state<HTMLDivElement | null>(null);

	$effect(() => {
		void messages.length;
		void tick().then(() => list?.scrollTo({ top: list.scrollHeight }));
	});

	function submit(event: Event) {
		event.preventDefault();
		const text = draft.trim();
		if (!text) return;
		onSend(text);
		draft = '';
	}
</script>

<div class="thread" class:compact>
	<div class="list" bind:this={list}>
		{#each messages as m (m.id)}
			<div class="msg" class:mine={m.mine}>
				<span class="dot" style="background: {m.color}">{m.handle.slice(0, 1).toUpperCase()}</span>
				<div class="body">
					<div class="meta">
						<span class="handle" style="color: {m.color}">{m.handle}</span>
						<span class="time">{m.time}</span>
					</div>
					<div class="text">{m.text}</div>
				</div>
			</div>
		{/each}
	</div>
	{#if signedIn}
		<form class="compose" onsubmit={submit}>
			<input
				class="sh-input"
				placeholder="Say something to everyone…"
				maxlength="500"
				bind:value={draft}
				aria-label="Message"
			/>
			<button type="submit" class="sh-btn sh-btn-primary send" disabled={!draft.trim()}>Send</button>
		</form>
	{:else}
		<div class="compose signin"><button class="sh-btn sh-btn-primary sh-btn-block">Sign in to chat</button></div>
	{/if}
</div>

<style>
	.thread {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}
	.list {
		flex: 1;
		overflow-y: auto;
		padding: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.compact .list {
		gap: 0.35rem;
		padding: 0.5rem;
	}
	.msg {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
	}
	.dot {
		flex: none;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		font-size: 0.7rem;
		font-weight: 700;
		color: #111;
	}
	.compact .dot {
		width: 20px;
		height: 20px;
		font-size: 0.6rem;
	}
	.body {
		min-width: 0;
	}
	.meta {
		display: flex;
		gap: 0.4rem;
		align-items: baseline;
		font-size: 0.72rem;
	}
	.handle {
		font-weight: 600;
	}
	.time {
		color: #999;
	}
	.text {
		font-size: 0.9rem;
		line-height: 1.3;
		overflow-wrap: anywhere;
	}
	.compact .text {
		font-size: 0.82rem;
	}
	.mine .text {
		color: #fffaf0;
	}
	.compose {
		display: flex;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		border-top: 1px solid #2d2d2d;
		background: #1e1e1e;
		flex: none;
	}
	.compose .sh-input {
		flex: 1;
	}
	.send {
		flex: none;
	}
</style>
