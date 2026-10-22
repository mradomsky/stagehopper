import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from './api.js';

vi.mock('./auth.svelte.js', () => ({ getApiToken: async () => 'jwt' }));

const { FestivalChat } = await import('./festival-chat.svelte.js');

const ME = { nickname: 'alex', colour: '#e74c3c' as string | null };
let admin = false;
let profile: { nickname: string; colour: string | null } | null;
let hidden: boolean;
let myId: string | null;
const onNeedColour = vi.fn();

function mid(n: number): string {
	return `${1_700_000_000_000 + n}-aaaaaaaa`;
}
function msg(n: number, handle = 'sam', text = `m${n}`, userId = `clerk:${handle}`): ChatMessage {
	return { messageId: mid(n), userId, nickname: handle, colour: '#3498db', text, createdAt: 1_700_000_000_000 + n };
}

type Reply = { status: number; body: unknown };
const server = {
	all: [] as ChatMessage[],
	calls: [] as string[],
	postReply: null as Reply | null,
	deleteReply: null as Reply | null,
	getReply: null as Reply | null,
	summary: { attendees: 3, latestMessage: null } as unknown,
	summaryFails: false
};

function res({ status, body }: Reply) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
	const method = init?.method ?? 'GET';
	const u = new URL(url, 'http://x');
	if (u.pathname.endsWith('/summary')) {
		server.calls.push('GET summary');
		if (server.summaryFails) return res({ status: 500, body: {} });
		return res({ status: 200, body: server.summary });
	}
	if (/\/messages\/[^/]+$/.test(u.pathname)) {
		server.calls.push(`DELETE ${decodeURIComponent(u.pathname.split('/').pop()!)}`);
		return res(server.deleteReply ?? { status: 200, body: { ok: true } });
	}
	if (method === 'POST') {
		server.calls.push(`POST ${JSON.parse(init!.body as string).text}`);
		if (server.postReply) return res(server.postReply);
		const posted = msg(900 + server.all.length, ME.nickname, JSON.parse(init!.body as string).text);
		return res({ status: 201, body: { message: posted } });
	}
	server.calls.push(`GET messages${u.search}`);
	if (server.getReply) return res(server.getReply);
	const after = u.searchParams.get('after');
	const before = u.searchParams.get('before');
	const sorted = [...server.all].sort((a, b) => (a.messageId < b.messageId ? -1 : 1));
	let page: ChatMessage[];
	if (after) page = sorted.filter((m) => m.messageId > after).slice(0, 200);
	else if (before) page = sorted.filter((m) => m.messageId < before).slice(-200);
	else page = sorted.slice(-200);
	return res({ status: 200, body: { messages: page } });
});

function makeChat() {
	return new FestivalChat({
		profile: () => profile,
		myId: () => myId,
		onNeedColour,
		isAdmin: () => admin,
		isHidden: () => hidden
	});
}

function setHidden(value: boolean) {
	hidden = value;
	document.dispatchEvent(new Event('visibilitychange'));
}

const polls = () => server.calls.filter((c) => c.startsWith('GET messages?after'));
const ids = (chat: InstanceType<typeof FestivalChat>) => chat.messages.map((m) => m.messageId);

let chat: InstanceType<typeof FestivalChat>;

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal('fetch', fetchMock);
	fetchMock.mockClear();
	Object.assign(server, {
		all: [],
		calls: [],
		postReply: null,
		deleteReply: null,
		getReply: null,
		summary: { attendees: 3, latestMessage: null },
		summaryFails: false
	});
	profile = { ...ME };
	myId = 'clerk:alex';
	hidden = false;
	admin = false;
	onNeedColour.mockReset();
	chat = makeChat();
});

afterEach(() => {
	chat.dispose();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function openWith(count: number) {
	server.all = Array.from({ length: count }, (_, i) => msg(i + 1));
	void chat.open('tmr26');
	await vi.advanceTimersByTimeAsync(0);
}

describe('open', () => {
	it('loads the newest page, oldest first, plus the summary', async () => {
		await openWith(3);
		expect(ids(chat)).toEqual([mid(1), mid(2), mid(3)]);
		expect(chat.latest?.messageId).toBe(mid(3));
		expect(chat.here).toBe(3);
		expect(chat.loading).toBe(false);
		expect(chat.hasOlder).toBe(false);
	});

	it('is idempotent per id and resets on a new id', async () => {
		await openWith(2);
		void chat.open('tmr26');
		await vi.advanceTimersByTimeAsync(0);
		expect(server.calls.filter((c) => c === 'GET messages')).toHaveLength(1);

		server.all = [msg(7)];
		void chat.open('other');
		await vi.advanceTimersByTimeAsync(0);
		expect(ids(chat)).toEqual([mid(7)]);
	});

	it('a full first page says older Messages exist', async () => {
		await openWith(200);
		expect(chat.hasOlder).toBe(true);
	});

	it('a failed first load is flagged and retry loads again', async () => {
		server.getReply = { status: 500, body: {} };
		void chat.open('tmr26');
		await vi.advanceTimersByTimeAsync(0);
		expect(chat.loadError).toBe(true);
		server.getReply = null;
		server.all = [msg(1)];
		void chat.retry();
		await vi.advanceTimersByTimeAsync(0);
		expect(chat.loadError).toBe(false);
		expect(ids(chat)).toEqual([mid(1)]);
	});
});

describe('polling', () => {
	it('(b) the cursor is the newest id a GET returned, never a POST', async () => {
		await openWith(1);
		// another user's message arrives; before we poll, our own POST lands after it
		server.all.push(msg(2));
		chat.draft = 'mine';
		await chat.send();
		server.all.push(msg(950, ME.nickname, 'mine'));
		await vi.advanceTimersByTimeAsync(5000);
		expect(polls().at(-1)).toBe(`GET messages?after=${mid(1)}`);
		expect(ids(chat)).toContain(mid(2));
		// nothing is duplicated
		expect(new Set(ids(chat)).size).toBe(chat.messages.length);
	});

	it('(c) a full page re-polls at once until a short page', async () => {
		await openWith(1);
		server.all = [msg(1), ...Array.from({ length: 205 }, (_, i) => msg(10 + i))];
		await vi.advanceTimersByTimeAsync(5000);
		expect(polls()).toHaveLength(2);
		expect(chat.messages).toHaveLength(206);
	});

	it('(d) one poll in flight; a stale festival response is dropped', async () => {
		await openWith(1);
		let release!: (r: ReturnType<typeof res>) => void;
		fetchMock.mockImplementationOnce(
			() => new Promise((resolve) => (release = resolve as typeof release))
		);
		await vi.advanceTimersByTimeAsync(5000);
		await vi.advanceTimersByTimeAsync(5000);
		expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('after='))).toHaveLength(1);
		void chat.open('other');
		release(res({ status: 200, body: { messages: [msg(99, 'late')] } }));
		await vi.advanceTimersByTimeAsync(0);
		expect(ids(chat)).not.toContain(mid(99));
	});

	it('(e) timer stops while hidden; one immediate poll on return, then every 5 s', async () => {
		await openWith(1);
		setHidden(true);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(polls()).toHaveLength(0);
		setHidden(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(polls()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(5000);
		expect(polls()).toHaveLength(2);
	});

	it('dispose stops the timer and drops responses', async () => {
		await openWith(1);
		chat.dispose();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(polls()).toHaveLength(0);
		expect(chat.messages).toEqual([]);
	});
});

describe('merge', () => {
	it('(a) arrivals, posts and older pages merge unique and sorted', async () => {
		await openWith(200);
		server.all.push(msg(500));
		await vi.advanceTimersByTimeAsync(5000);
		await chat.send().catch(() => {});
		await chat.loadOlder();
		const all = ids(chat);
		expect(new Set(all).size).toBe(all.length);
		expect(all).toEqual([...all].sort());
	});

	it('loadOlder prepends the previous page and clears hasOlder on a short page', async () => {
		server.all = Array.from({ length: 205 }, (_, i) => msg(i + 1));
		void chat.open('tmr26');
		await vi.advanceTimersByTimeAsync(0);
		expect(chat.messages).toHaveLength(200);
		expect(chat.hasOlder).toBe(true);
		await chat.loadOlder();
		expect(chat.messages).toHaveLength(205);
		expect(chat.messages[0]!.messageId).toBe(mid(1));
		expect(chat.hasOlder).toBe(false);
		expect(server.calls.at(-1)).toBe(`GET messages?before=${mid(6)}`);
	});
});

describe('(f) unread', () => {
	it('counts poll arrivals not mine while collapsed; expanding clears and stops counting', async () => {
		await openWith(1);
		server.all.push(msg(2), msg(3, ME.nickname));
		await vi.advanceTimersByTimeAsync(5000);
		expect(chat.unread).toBe(1);
		chat.setExpanded(true);
		expect(chat.unread).toBe(0);
		server.all.push(msg(4));
		await vi.advanceTimersByTimeAsync(5000);
		expect(chat.unread).toBe(0);
		chat.setExpanded(false);
		server.all.push(msg(5));
		await vi.advanceTimersByTimeAsync(5000);
		expect(chat.unread).toBe(1);
	});

	it('first load, own posts and older pages never count', async () => {
		server.all = Array.from({ length: 205 }, (_, i) => msg(i + 1));
		void chat.open('tmr26');
		await vi.advanceTimersByTimeAsync(0);
		chat.draft = 'hi';
		await chat.send();
		await chat.loadOlder();
		expect(chat.unread).toBe(0);
	});
});

describe('(g) send', () => {
	beforeEach(async () => {
		await openWith(1);
	});

	it('is not optimistic: appends on 201 and clears the draft', async () => {
		chat.draft = ' hello ';
		const pending = chat.send();
		expect(chat.sending).toBe(true);
		expect(chat.messages).toHaveLength(1);
		await pending;
		expect(chat.messages.at(-1)?.text).toBe('hello');
		expect(chat.draft).toBe('');
		expect(chat.sending).toBe(false);
	});

	it('canSend needs non-blank text of at most 500 characters', () => {
		chat.draft = '   ';
		expect(chat.canSend).toBe(false);
		chat.draft = 'x'.repeat(501);
		expect(chat.canSend).toBe(false);
		chat.draft = 'x'.repeat(500);
		expect(chat.canSend).toBe(true);
	});

	it('429 shows slow-down, keeps the draft, clears after 3 s', async () => {
		server.postReply = { status: 429, body: { error: 'too fast' } };
		chat.draft = 'again';
		await chat.send();
		expect(chat.notice).toBe('slow-down');
		expect(chat.draft).toBe('again');
		await vi.advanceTimersByTimeAsync(3000);
		expect(chat.notice).toBe('');
	});

	it('429 clears on the next draft change', async () => {
		server.postReply = { status: 429, body: { error: 'too fast' } };
		chat.draft = 'again';
		await chat.send();
		chat.draft = 'again!';
		expect(chat.notice).toBe('');
	});

	it('403 bans for the rest of the page session', async () => {
		server.postReply = { status: 403, body: { error: 'no' } };
		chat.draft = 'x';
		await chat.send();
		expect(chat.banned).toBe(true);
		expect(chat.canSend).toBe(false);
		chat.draft = 'y';
		expect(chat.canSend).toBe(false);
	});

	it('400 about colour opens the Colour modal and keeps the draft', async () => {
		server.postReply = { status: 400, body: { error: 'choose a colour first' } };
		chat.draft = 'x';
		await chat.send();
		expect(onNeedColour).toHaveBeenCalledOnce();
		expect(chat.draft).toBe('x');
		expect(chat.notice).toBe('');
	});

	it('a profile without a Colour opens the modal without a request', async () => {
		profile = { nickname: 'alex', colour: null };
		chat.draft = 'x';
		await chat.send();
		expect(onNeedColour).toHaveBeenCalledOnce();
		expect(server.calls.some((c) => c.startsWith('POST'))).toBe(false);
		expect(chat.draft).toBe('x');
	});

	it('another failure says failed and keeps the draft', async () => {
		server.postReply = { status: 500, body: {} };
		chat.draft = 'x';
		await chat.send();
		expect(chat.notice).toBe('failed');
		expect(chat.draft).toBe('x');
	});
});

describe('(h) remove', () => {
	beforeEach(async () => {
		await openWith(2);
	});

	it('drops the Message locally on 200', async () => {
		await chat.remove(mid(2));
		expect(ids(chat)).toEqual([mid(1)]);
		expect(server.calls.at(-1)).toBe(`DELETE ${mid(2)}`);
	});

	it('403 is a failure, not a ban; the Message stays', async () => {
		server.deleteReply = { status: 403, body: { error: 'not yours' } };
		await chat.remove(mid(2));
		expect(chat.notice).toBe('failed');
		expect(chat.banned).toBe(false);
		expect(ids(chat)).toContain(mid(2));
	});
});

describe('isMine', () => {
	it('matches by user id only, whatever the Handle says', async () => {
		await openWith(1);
		expect(chat.isMine(msg(1, 'alex'))).toBe(true);
		expect(chat.isMine(msg(1, 'sam'))).toBe(false);
		expect(chat.isMine(msg(1, 'alex', 'x', 'clerk:other'))).toBe(false);
		expect(chat.isMine(msg(1, 'old-name', 'x', 'clerk:alex'))).toBe(true);
	});

	it('is never true for a Visitor or a Message without a user id', async () => {
		await openWith(1);
		myId = null;
		expect(chat.isMine(msg(1, 'alex'))).toBe(false);
		myId = '';
		expect(chat.isMine(msg(1, 'alex', 'x', ''))).toBe(false);
		myId = 'clerk:alex';
		expect(chat.isMine(msg(1, 'alex', 'x', ''))).toBe(false);
		expect(chat.isMine({ ...msg(1, 'alex'), userId: undefined } as unknown as ChatMessage)).toBe(
			false
		);
	});
});

describe('(i) summary', () => {
	it('is fetched on open and on return to visible, not on every poll', async () => {
		await openWith(1);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(server.calls.filter((c) => c === 'GET summary')).toHaveLength(1);
		setHidden(true);
		setHidden(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(server.calls.filter((c) => c === 'GET summary')).toHaveLength(2);
	});

	it('a failure keeps the old count', async () => {
		await openWith(1);
		server.summaryFails = true;
		setHidden(true);
		setHidden(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(chat.here).toBe(3);
	});

	it('a failure on open leaves it null', async () => {
		server.summaryFails = true;
		await openWith(1);
		expect(chat.here).toBeNull();
	});
});

describe('canDelete', () => {
	it('a non-Admin may delete only their own Message', async () => {
		await openWith(1);
		expect(chat.canDelete(msg(1, 'alex'))).toBe(true);
		expect(chat.canDelete(msg(1, 'sam'))).toBe(false);
		expect(chat.canDelete(msg(1, 'alex', 'x', 'clerk:other'))).toBe(false);
		expect(chat.canDelete(msg(1, 'old-name', 'x', 'clerk:alex'))).toBe(true);
	});

	it('a Visitor may not delete', async () => {
		await openWith(1);
		myId = null;
		expect(chat.canDelete(msg(1, 'alex'))).toBe(false);
	});

	it('an Admin may delete any Message; isMine is unchanged', async () => {
		await openWith(1);
		admin = true;
		expect(chat.canDelete(msg(1, 'sam'))).toBe(true);
		expect(chat.isMine(msg(1, 'sam'))).toBe(false);
	});

	it("an Admin removing another user's Message drops it locally", async () => {
		await openWith(2);
		admin = true;
		await chat.remove(mid(2));
		expect(ids(chat)).toEqual([mid(1)]);
		expect(server.calls.at(-1)).toBe(`DELETE ${mid(2)}`);
	});
});
