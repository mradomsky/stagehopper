<!-- PROTOTYPE A — "Chat is a tab". A third view next to Timetable / My Picks. Chat owns the
     whole screen when selected; the timetable is gone while you read. -->
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
	export const name = 'Chat tab';

	let tab = $state<'timetable' | 'chat'>('chat');
</script>

<div class="tabs">
	<button class="sh-btn-sm tab" class:active={tab === 'timetable'} onclick={() => (tab = 'timetable')}>
		⊞ Timetable
	</button>
	<button class="sh-btn-sm tab" class:active={tab === 'chat'} onclick={() => (tab = 'chat')}>
		💬 Chat
		{#if unread && tab !== 'chat'}<span class="badge">{unread}</span>{/if}
	</button>
	<span class="here">{PROTO_HERE_COUNT} here</span>
</div>

{#if tab === 'chat'}
	<div class="panel">
		<ChatThread {messages} {onSend} />
	</div>
{:else}
	{@render timetable()}
{/if}

<style>
	.tabs {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.3rem 0.75rem;
		background: #111;
		border-bottom: 1px solid #2d2d2d;
		flex: none;
	}
	.tab {
		position: relative;
	}
	.tab.active {
		background: #2a2a2a;
		color: #fffaf0;
		border-color: #666;
	}
	.badge {
		margin-left: 0.3rem;
		background: #e74c3c;
		color: #fff;
		border-radius: 999px;
		font-size: 0.65rem;
		padding: 0 0.35rem;
	}
	.here {
		margin-left: auto;
		color: #999;
		font-size: 0.75rem;
	}
	.panel {
		flex: 1;
		min-height: 0;
	}
	@media (max-width: 767px) {
		.panel {
			padding-bottom: 52px;
		}
	}
</style>
