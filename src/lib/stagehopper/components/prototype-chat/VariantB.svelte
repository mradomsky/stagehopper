<!-- PROTOTYPE B — "Chat beside the timetable". Desktop: a fixed right column, both always
     visible. Mobile: a bottom sheet that peeks the latest line and expands on tap. -->
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
	export const name = 'Side panel / bottom sheet';

	let expanded = $state(false);
	const last = $derived(messages[messages.length - 1]);
</script>

<div class="split">
	<div class="main">{@render timetable()}</div>

	<aside class="panel" class:expanded>
		<button class="handle" onclick={() => (expanded = !expanded)} aria-expanded={expanded}>
			<span class="title">💬 Festival chat</span>
			<span class="here">{PROTO_HERE_COUNT} here</span>
			{#if !expanded && last}
				<span class="peek">
					<b style="color: {last.color}">{last.handle}</b>: {last.text}
				</span>
				{#if unread}<span class="badge">{unread}</span>{/if}
			{/if}
			<span class="chev">{expanded ? '▾' : '▴'}</span>
		</button>
		<div class="body">
			<ChatThread {messages} {onSend} compact />
		</div>
	</aside>
</div>

<style>
	.split {
		flex: 1;
		min-height: 0;
		display: flex;
	}
	.main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.panel {
		width: 340px;
		flex: none;
		display: flex;
		flex-direction: column;
		background: #1e1e1e;
		border-left: 1px solid #2d2d2d;
	}
	.handle {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		background: #232323;
		border: 0;
		border-bottom: 1px solid #2d2d2d;
		color: #fffaf0;
		font: inherit;
		text-align: left;
		cursor: default;
	}
	.title {
		font-weight: 600;
		font-size: 0.85rem;
	}
	.here {
		color: #999;
		font-size: 0.72rem;
		margin-left: auto;
	}
	.peek,
	.chev,
	.badge {
		display: none;
	}
	.body {
		flex: 1;
		min-height: 0;
	}

	@media (max-width: 767px) {
		.split {
			flex-direction: column;
		}
		.panel {
			position: fixed;
			left: 0;
			right: 0;
			bottom: 52px;
			width: auto;
			height: 56px;
			border-left: 0;
			border-top: 1px solid #444;
			border-radius: 12px 12px 0 0;
			z-index: 15;
			transition: height 0.18s ease-out;
		}
		.panel.expanded {
			height: 72vh;
		}
		.handle {
			min-height: 56px;
			cursor: pointer;
			flex-wrap: wrap;
		}
		.here {
			margin-left: 0;
		}
		.peek {
			display: block;
			flex-basis: 100%;
			color: #aaa;
			font-size: 0.78rem;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.chev {
			display: inline;
			margin-left: auto;
			color: #999;
		}
		.badge {
			display: inline;
			background: #e74c3c;
			color: #fff;
			border-radius: 999px;
			font-size: 0.65rem;
			padding: 0 0.35rem;
		}
		.body {
			display: none;
		}
		.expanded .body {
			display: block;
		}
	}
</style>
