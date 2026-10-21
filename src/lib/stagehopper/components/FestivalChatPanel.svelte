<script lang="ts">
	import { tick } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import type { ChatMessage } from '../api.js';
	import { MAX_MESSAGE_LENGTH, type FestivalChat } from '../festival-chat.svelte.js';

	interface Props {
		chat: FestivalChat;
		signedIn: boolean;
		onSignIn: () => void;
		/** Phone only: the bottom sheet is open. The page hides its bottom bar while it is. */
		expanded?: boolean;
	}

	let { chat, signedIn, onSignIn, expanded = $bindable(false) }: Props = $props();

	/** At or above this width the chat is a right column that is always open. */
	const desktopQuery = typeof matchMedia === 'function' ? new MediaQuery('min-width: 768px') : null;
	const desktop = $derived(desktopQuery ? desktopQuery.current : true);
	const open = $derived(desktop || expanded);

	$effect(() => {
		chat.setExpanded(open);
	});

	/** How close to the end still counts as "at the bottom" (px). */
	const BOTTOM_SLACK = 24;

	let list = $state<HTMLDivElement | null>(null);
	let confirmId = $state<string | null>(null);

	function atBottom(el: HTMLElement): boolean {
		return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
	}

	// A new newest Message scrolls to the bottom only if the reader was already there; my own
	// post always does. Older pages prepend and leave the newest Message alone, so they never
	// trigger this. Measured before the DOM updates, applied after.
	let seenLatest: string | undefined;
	let seenPosts = 0;
	$effect.pre(() => {
		const latest = chat.latest?.messageId;
		const posts = chat.ownPosts;
		if (latest === seenLatest && posts === seenPosts) return;
		const stick = !list || posts !== seenPosts || atBottom(list);
		seenLatest = latest;
		seenPosts = posts;
		void tick().then(() => {
			if (stick && list) list.scrollTop = list.scrollHeight;
		});
	});

	// The list appears when the sheet opens: start at the newest Message.
	$effect(() => {
		if (list) list.scrollTop = list.scrollHeight;
	});

	/** Prepend the previous page and keep the Message that was on top at the same offset. */
	async function loadOlder() {
		const el = list;
		const before = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
		await chat.loadOlder();
		await tick();
		if (el && before) el.scrollTop = before.top + (el.scrollHeight - before.height);
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		void chat.send();
	}

	function confirmDelete() {
		const id = confirmId;
		confirmId = null;
		if (id) void chat.remove(id);
	}

	function time(message: ChatMessage): string {
		return new Date(message.createdAt).toLocaleTimeString([], {
			hour: '2-digit',
			minute: '2-digit'
		});
	}
</script>

{#snippet title()}
	<span class="title">Festival chat</span>
	{#if chat.here !== null}<span class="here">· {chat.here} here</span>{/if}
{/snippet}

<aside class="panel" class:open aria-label="Festival chat">
	{#if desktop}
		<div class="handle">{@render title()}</div>
	{:else}
		<button
			type="button"
			class="handle handle-button"
			aria-expanded={expanded}
			aria-label={chat.unread > 0 && !expanded ? `Festival chat, ${chat.unread} unread` : undefined} onclick={() => (expanded = !expanded)}>
			{@render title()}
			{#if chat.unread > 0 && !expanded}
				<span class="badge" aria-hidden="true">{chat.unread}</span>
			{/if}
			<span class="chevron" aria-hidden="true">{expanded ? '▾' : '▴'}</span>
			{#if !expanded && chat.latest}
				<span class="peek">
					<b style:color={chat.latest.colour}>{chat.latest.handle}</b>: {chat.latest.text}
				</span>
			{/if}
		</button>
	{/if}

	{#if open}
		<div class="thread">
			<div class="list" bind:this={list} role="log" aria-label="Messages">
				{#if chat.hasOlder}
					<button
						type="button"
						class="sh-btn sh-btn-secondary older"
						disabled={chat.loadingOlder}
						onclick={() => void loadOlder()}
					>
						{chat.loadingOlder ? 'Loading…' : 'Load older'}
					</button>
				{/if}
				{#if chat.loading}
					<p class="empty">Loading the chat…</p>
				{:else if chat.loadError}
					<p class="sh-error">Couldn't load the chat.</p>
					<button type="button" class="sh-btn sh-btn-secondary" onclick={() => void chat.retry()}>
						Try again
					</button>
				{:else if chat.messages.length === 0}
					<p class="empty">No messages yet.</p>
				{/if}
				{#each chat.messages as message (message.messageId)}
					<div class="msg" class:mine={chat.isMine(message)}>
						<span class="dot" style:background={message.colour} aria-hidden="true">
							{message.handle.slice(0, 1).toUpperCase()}
						</span>
						<div class="msg-body">
							<div class="meta">
								<span class="msg-handle" style:color={message.colour}>{message.handle}</span>
								<span class="time">{time(message)}</span>
								{#if chat.isMine(message)}
									<button
										type="button"
										class="delete"
										aria-label="Delete message"
										onclick={() => (confirmId = message.messageId)}
									>
										✕
									</button>
								{/if}
							</div>
							<div class="text">{message.text}</div>
						</div>
					</div>
				{/each}
			</div>

			{#if chat.notice === 'failed'}
				<p class="sh-error status" role="status">That didn't work. Try again.</p>
			{:else if chat.notice === 'slow-down'}
				<p class="status slow" role="status">Slow down a little.</p>
			{/if}

			{#if !signedIn}
				<div class="compose">
					<button type="button" class="sh-btn sh-btn-primary sh-btn-block" onclick={onSignIn}>
						Sign in to chat
					</button>
				</div>
			{:else if chat.banned}
				<p class="compose banned" role="status">You can't post in this chat.</p>
			{:else}
				<form class="compose" onsubmit={submit}>
					<input
						class="sh-input"
						placeholder="Say something to everyone…"
						aria-label="Message"
						maxlength={MAX_MESSAGE_LENGTH}
						autocomplete="off"
						bind:value={chat.draft}
					/>
					<button type="submit" class="sh-btn sh-btn-primary send" disabled={!chat.canSend}>
						Send
					</button>
				</form>
			{/if}
		</div>
	{/if}
</aside>

{#if confirmId}
	<ConfirmDialog
		title="Delete this message?"
		confirmLabel="Delete"
		onConfirm={confirmDelete}
		onCancel={() => (confirmId = null)}
	/>
{/if}

<style>
	.panel {
		width: 340px;
		flex: none;
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: var(--sh-surface-low);
		border-left: 1px solid var(--sh-border);
	}

	.handle {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.6rem 0.75rem;
		background: var(--sh-surface-overlay);
		border-bottom: 1px solid var(--sh-border);
		color: var(--sh-text);
		font: inherit;
		text-align: left;
	}

	.title {
		font-weight: 600;
		font-size: 0.9rem;
	}

	.here {
		color: var(--sh-text-muted);
		font-size: 0.78rem;
	}

	.thread {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 0.6rem 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.older {
		align-self: center;
		padding: 0.4rem 1rem;
		font-size: 0.8rem;
	}

	.empty {
		margin: auto;
		color: var(--sh-text-muted);
		font-size: 0.85rem;
	}

	.msg {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
	}

	.dot {
		flex: none;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		font-size: 0.7rem;
		font-weight: 700;
		color: var(--sh-fixed-black);
	}

	.msg-body {
		min-width: 0;
		flex: 1;
	}

	.meta {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		font-size: 0.72rem;
	}

	.msg-handle {
		font-weight: 600;
	}

	.time {
		color: var(--sh-text-muted);
	}

	.delete {
		margin-left: auto;
		background: transparent;
		border: 0;
		color: var(--sh-text-muted);
		font-size: 0.8rem;
		padding: 0.15rem 0.4rem;
		cursor: pointer;
		border-radius: 6px;
	}

	.delete:focus-visible,
	.handle-button:focus-visible {
		outline: 2px solid var(--sh-accent);
		outline-offset: -2px;
	}

	.text {
		font-size: 0.88rem;
		line-height: 1.35;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	.status {
		margin: 0;
		padding: 0.3rem 0.75rem;
		font-size: 0.8rem;
	}

	.slow {
		color: var(--sh-text-muted);
	}

	.compose {
		display: flex;
		gap: 0.5rem;
		margin: 0;
		padding: 0.6rem 0.75rem;
		border-top: 1px solid var(--sh-border);
		flex: none;
	}

	.compose .sh-input {
		flex: 1;
		min-width: 0;
	}

	.send {
		flex: none;
		padding: 0.55rem 1rem;
	}

	.banned {
		color: var(--sh-text-muted);
		font-size: 0.85rem;
		justify-content: center;
	}

	@media (hover: hover) and (pointer: fine) {
		.delete:hover {
			color: var(--sh-text-strong);
			background: var(--sh-hover-wash);
		}
	}

	/* Phones: a bottom sheet above the 52px bottom bar. Collapsed it peeks the latest line. */
	@media (max-width: 767px) {
		.panel {
			position: fixed;
			left: 0;
			right: 0;
			bottom: 52px;
			width: auto;
			height: 56px;
			border-left: 0;
			border-top: 1px solid var(--sh-border-strong);
			border-radius: 12px 12px 0 0;
			z-index: 15;
			transition: height 0.18s ease-out;
		}

		@media (prefers-reduced-motion: reduce) {
			.panel {
				transition: none;
			}
		}

		.panel.open {
			bottom: 0;
			height: 72vh;
		}

		.handle-button {
			display: flex;
			flex-wrap: wrap;
			min-height: 56px;
			width: 100%;
			border-top: 0;
			border-left: 0;
			border-right: 0;
			border-radius: 12px 12px 0 0;
			cursor: pointer;
		}

		.chevron {
			display: inline;
			margin-left: auto;
			color: var(--sh-text-muted);
		}

		.badge {
			display: inline-block;
			background: var(--sh-accent);
			color: var(--sh-on-accent);
			border-radius: 999px;
			font-size: 0.7rem;
			padding: 0 0.4rem;
		}

		.peek {
			display: block;
			flex-basis: 100%;
			color: var(--sh-text-muted);
			font-size: 0.78rem;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.delete {
			min-width: 44px;
			min-height: 44px;
			margin: -0.6rem -0.4rem -0.6rem auto;
		}

		.older,
		.send {
			min-height: 44px;
		}

		.compose :global(.sh-input) {
			font-size: 16px;
			min-height: 44px;
		}
	}

	/* Landscape phones: the bottom bar is a left rail instead, so the sheet clears the rail. */
	@media (max-width: 767px) and (orientation: landscape) {
		.panel {
			left: 44px;
			bottom: 0;
		}
	}
</style>
