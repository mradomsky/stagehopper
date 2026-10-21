import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import type { ChatMessage } from '../api.js';

vi.mock('../auth.svelte.js', () => ({ getApiToken: async () => 'jwt' }));

const { default: FestivalChatPanel } = await import('./FestivalChatPanel.svelte');
const { FestivalChat } = await import('../festival-chat.svelte.js');

function msg(n: number, handle = 'sam', text = `m${n}`): ChatMessage {
	return {
		messageId: `${1_700_000_000_000 + n}-aaaaaaaa`,
		handle,
		colour: '#3498db',
		text,
		createdAt: 1_700_000_000_000 + n
	};
}

let server: ChatMessage[];
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
	const reply = (body: unknown, status = 200) => ({
		ok: status < 300,
		status,
		json: async () => body
	});
	if (url.endsWith('/summary')) return reply({ attendees: 1, latestMessage: null });
	if (init?.method === 'POST') {
		const { text } = JSON.parse(init.body as string) as { text: string };
		return reply({ message: msg(900, 'alex', text) }, 201);
	}
	const after = new URL(url, 'http://x').searchParams.get('after');
	return reply({ messages: server.filter((m) => !after || m.messageId > after) });
});

/** jsdom has no layout: give the list a height, a viewport and a scroll offset. */
function stubLayout(list: HTMLElement, top: number) {
	const state = { top };
	Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 1000 });
	Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 400 });
	Object.defineProperty(list, 'scrollTop', {
		configurable: true,
		get: () => state.top,
		set: (value: number) => (state.top = value)
	});
	return state;
}

async function mount(isAdmin = false) {
	server = [msg(1), msg(2), msg(0, 'alex', 'my own')];
	const chat = new FestivalChat({
		profile: () => ({ handle: 'alex', colour: '#e74c3c' }),
		onNeedColour: () => {},
		isAdmin: () => isAdmin
	});
	render(FestivalChatPanel, { chat, signedIn: true, onSignIn: () => {} });
	void chat.open('tmr26');
	await vi.advanceTimersByTimeAsync(0);
	return { chat, list: screen.getByRole('log') };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('FestivalChatPanel auto-scroll', () => {
	it('follows a new Message when the reader was at the bottom', async () => {
		const { chat, list } = await mount();
		const view = stubLayout(list, 600);
		server.push(msg(3));
		await vi.advanceTimersByTimeAsync(5000);
		expect(screen.getByText("m3")).toBeInTheDocument();
		expect(view.top).toBe(1000);
		chat.dispose();
	});

	it('leaves a reader who scrolled up where they are', async () => {
		const { chat, list } = await mount();
		const view = stubLayout(list, 100);
		server.push(msg(3));
		await vi.advanceTimersByTimeAsync(5000);
		expect(screen.getByText("m3")).toBeInTheDocument();
		expect(view.top).toBe(100);
		chat.dispose();
	});

	it('always scrolls to the bottom for my own post', async () => {
		const { chat, list } = await mount();
		const view = stubLayout(list, 100);
		await fireEvent.input(screen.getByRole('textbox', { name: 'Message' }), {
			target: { value: 'mine' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.getByText('mine')).toBeInTheDocument();
		expect(view.top).toBe(1000);
		chat.dispose();
	});
});

describe('FestivalChatPanel delete', () => {
	const deleteButtons = () => screen.queryAllByRole('button', { name: 'Delete message' });

	it('a non-Admin gets delete on their own Message only', async () => {
		const { chat } = await mount(false);
		expect(deleteButtons()).toHaveLength(1);
		chat.dispose();
	});

	it('an Admin gets delete on every Message', async () => {
		const { chat } = await mount(true);
		expect(deleteButtons()).toHaveLength(3);
		chat.dispose();
	});

	it("confirming an Admin delete of another's Message removes it and names the author", async () => {
		const { chat } = await mount(true);
		await fireEvent.click(deleteButtons()[1]!);
		const dialog = screen.getByRole('dialog', { name: "Delete @sam's message?" });
		await fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.queryByText('m1')).toBeNull();
		expect(screen.getByText('m2')).toBeInTheDocument();
		chat.dispose();
	});

	it('my own Message keeps the plain confirm copy, even as Admin', async () => {
		const { chat } = await mount(true);
		await fireEvent.click(deleteButtons()[0]!);
		expect(screen.getByRole('dialog', { name: 'Delete this message?' })).toBeInTheDocument();
		chat.dispose();
	});
});
