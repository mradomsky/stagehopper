/**
 * @file The state of the Festival chat: its Messages, polling, unread count and compose box.
 *
 * The panel renders this and owns no logic. Interface:
 *
 * - `open(festivalId)` (idempotent per id), `retry()`, `dispose()`.
 * - `send()`, `loadOlder()`, `remove(messageId)` (the caller confirms first), `setExpanded(open)`.
 * - Reads: `messages` (oldest first), `latest`, `here`, `unread`, `hasOlder`, `loading`,
 *   `loadError`, `sending`, `notice`, `banned`, `draft`, `canSend`, `ownPosts`, `isMine`,
 *   `canDelete`.
 *
 * Invariants worth knowing before editing:
 *
 * 1. Every insert goes through `#merge`: unique by `messageId`, sorted by it. Ids sort by time.
 * 2. The poll cursor is the newest id a GET returned. A POST never moves it: it can be newer
 *    than another user's Message that no poll has seen yet, and advancing past that would
 *    lose it.
 * 3. A full page (200) re-polls at once. One poll runs at a time.
 * 4. Responses that began before `open` re-pointed or `dispose` ran are dropped (`#gen`).
 * 5. Polling runs only while open and visible; returning to visible polls once at once.
 * 6. Unread counts poll arrivals not mine, only while collapsed. First load, own posts and
 *    older pages never count.
 */

import {
	deleteFestivalMessage,
	fetchFestivalMessages,
	fetchFestivalSummary,
	postFestivalMessage,
	type AttendeeProfile,
	type ChatMessage
} from './api.js';

/** How often new Messages are fetched while the page is visible. */
export const CHAT_POLL_MS = 5000;
/** How long the "slow down" status stays when the user does not type. */
export const SLOW_DOWN_MS = 3000;
/** The API's cap on one Message, and on one page. */
export const MAX_MESSAGE_LENGTH = 500;
const PAGE_SIZE = 200;
/** What the backend says, matched loosely: the only way to tell its 400s apart. */
const COLOUR_REQUIRED = /colour/i;

export type ChatNotice = '' | 'slow-down' | 'banned' | 'failed';

export interface FestivalChatDeps {
	profile: () => AttendeeProfile | null;
	/** The signed-in user's public id (`clerk:${id}`), null for a Visitor. */
	myId: () => string | null;
	onNeedColour: () => void;
	/** Presentation only: whether to offer delete on others' Messages. The API enforces the scope. */
	isAdmin: () => boolean;
	isHidden?: () => boolean;
}

export class FestivalChat {
	#deps: FestivalChatDeps;

	festivalId = $state('');
	messages = $state<ChatMessage[]>([]);
	/** Attendees at this Festival, from the summary; null until it has answered. */
	here = $state<number | null>(null);
	unread = $state(0);
	hasOlder = $state(false);
	loading = $state(false);
	loadError = $state(false);
	loadingOlder = $state(false);
	sending = $state(false);
	notice = $state<ChatNotice>('');
	/** A post was refused with 403: the compose box is gone for the rest of this page session. */
	banned = $state(false);
	/** Counts my successful posts, so the panel can scroll to the bottom for each. */
	ownPosts = $state(0);
	#draft = $state('');
	#expanded = false;

	#gen = 0;
	#open = false;
	#loaded = false;
	#cursor: string | null = null;
	#polling = false;
	#pollTimer: ReturnType<typeof setInterval> | null = null;
	#noticeTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(deps: FestivalChatDeps) {
		this.#deps = deps;
	}

	// ---- Reads ----

	get latest(): ChatMessage | null {
		return this.messages.at(-1) ?? null;
	}
	get draft(): string {
		return this.#draft;
	}
	set draft(value: string) {
		this.#draft = value;
		if (this.notice === 'slow-down' || this.notice === 'failed') this.#setNotice('');
	}
	get canSend(): boolean {
		const text = this.#draft.trim();
		return text.length > 0 && text.length <= MAX_MESSAGE_LENGTH && !this.sending && !this.banned;
	}
	isMine(message: ChatMessage): boolean {
		const myId = this.#deps.myId();
		return !!myId && message.userId === myId;
	}
	/** The delete action is offered: my own Message, or any Message when I am an Admin. */
	canDelete(message: ChatMessage): boolean {
		return this.isMine(message) || this.#deps.isAdmin();
	}

	// ---- Lifecycle ----

	/** Point at a Festival: load the newest page and the summary, then poll while visible. */
	open(festivalId: string): Promise<void> {
		if (this.#open && this.festivalId === festivalId) return Promise.resolve();
		this.dispose();
		this.#open = true;
		this.festivalId = festivalId;
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', this.#onVisibilityChange);
		}
		if (!this.#hidden()) this.#startTimer();
		void this.#loadSummary();
		return this.#load();
	}

	/** Load the first page again after it failed. */
	retry(): Promise<void> {
		if (!this.#open || this.#loaded) return Promise.resolve();
		return this.#load();
	}

	/** Stop polling and drop everything. Responses still in flight are ignored. */
	dispose(): void {
		this.#gen++;
		this.#open = false;
		this.#loaded = false;
		this.#polling = false;
		this.#cursor = null;
		this.#stopTimer();
		if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
		this.#noticeTimer = null;
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', this.#onVisibilityChange);
		}
		this.festivalId = '';
		this.messages = [];
		this.here = null;
		this.unread = 0;
		this.hasOlder = false;
		this.loading = false;
		this.loadError = false;
		this.loadingOlder = false;
		this.sending = false;
		this.notice = '';
		this.banned = false;
		this.ownPosts = 0;
		this.#draft = '';
	}

	/** The panel is on screen: Messages that arrive from now on are read, and unread is cleared. */
	setExpanded(open: boolean): void {
		this.#expanded = open;
		if (open) this.unread = 0;
	}

	// ---- Actions ----

	async send(): Promise<void> {
		if (!this.canSend || !this.#open) return;
		const profile = this.#deps.profile();
		if (profile && !profile.colour) {
			this.#deps.onNeedColour();
			return;
		}
		const gen = this.#gen;
		const id = this.festivalId;
		const text = this.#draft.trim();
		this.sending = true;
		this.#setNotice('');
		const result = await postFestivalMessage(id, text);
		if (gen !== this.#gen) return;
		this.sending = false;
		if (result.ok) {
			this.#merge([result.data.message]);
			this.#draft = '';
			this.ownPosts++;
			return;
		}
		if (result.status === 429) {
			this.#setNotice('slow-down');
			this.#noticeTimer = setTimeout(() => this.#setNotice(''), SLOW_DOWN_MS);
		} else if (result.status === 403) {
			this.banned = true;
		} else if (result.status === 400 && COLOUR_REQUIRED.test(result.error ?? '')) {
			this.#deps.onNeedColour();
		} else {
			this.#setNotice('failed');
		}
	}

	async loadOlder(): Promise<void> {
		const oldest = this.messages[0];
		if (!this.#open || !oldest || this.loadingOlder || !this.hasOlder) return;
		const gen = this.#gen;
		this.loadingOlder = true;
		const result = await fetchFestivalMessages(this.festivalId, { before: oldest.messageId });
		if (gen !== this.#gen) return;
		this.loadingOlder = false;
		if (!result.ok) {
			this.#setNotice('failed');
			return;
		}
		this.#merge(result.data.messages);
		this.hasOlder = result.data.messages.length >= PAGE_SIZE;
	}

	/** Delete a Message (mine, or any as Admin). A 403 here is a failed delete, never a ban. */
	async remove(messageId: string): Promise<void> {
		if (!this.#open) return;
		const gen = this.#gen;
		const result = await deleteFestivalMessage(this.festivalId, messageId);
		if (gen !== this.#gen) return;
		if (result.ok) this.messages = this.messages.filter((m) => m.messageId !== messageId);
		else this.#setNotice('failed');
	}

	// ---- Internals ----

	#hidden(): boolean {
		return this.#deps.isHidden
			? this.#deps.isHidden()
			: typeof document !== 'undefined' && document.hidden;
	}

	#setNotice(notice: ChatNotice) {
		if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
		this.#noticeTimer = null;
		this.notice = notice;
	}

	/** Unique by id, sorted by id. Returns the Messages that were not here before. */
	#merge(incoming: ChatMessage[]): ChatMessage[] {
		const known = new Map(this.messages.map((m) => [m.messageId, m]));
		const fresh: ChatMessage[] = [];
		for (const message of incoming) {
			if (!known.has(message.messageId)) fresh.push(message);
			known.set(message.messageId, message);
		}
		this.messages = [...known.values()].sort((a, b) => (a.messageId < b.messageId ? -1 : 1));
		return fresh;
	}

	async #load(): Promise<void> {
		const gen = this.#gen;
		this.loading = true;
		this.loadError = false;
		const result = await fetchFestivalMessages(this.festivalId);
		if (gen !== this.#gen) return;
		this.loading = false;
		if (!result.ok) {
			this.loadError = true;
			return;
		}
		const page = result.data.messages;
		this.#merge(page);
		this.#cursor = page.at(-1)?.messageId ?? null;
		this.hasOlder = page.length >= PAGE_SIZE;
		this.#loaded = true;
	}

	async #loadSummary(): Promise<void> {
		const gen = this.#gen;
		const result = await fetchFestivalSummary(this.festivalId);
		if (gen === this.#gen && result.ok) this.here = result.data.attendees;
	}

	async #poll(): Promise<void> {
		if (!this.#open || this.#polling) return;
		if (!this.#loaded) {
			await this.retry();
			return;
		}
		const gen = this.#gen;
		this.#polling = true;
		try {
			for (;;) {
				const result = await fetchFestivalMessages(
					this.festivalId,
					this.#cursor ? { after: this.#cursor } : {}
				);
				if (gen !== this.#gen || !result.ok) return;
				const page = result.data.messages;
				const fresh = this.#merge(page);
				if (page.length > 0) this.#cursor = page[page.length - 1]!.messageId;
				if (!this.#expanded) this.unread += fresh.filter((m) => !this.isMine(m)).length;
				if (page.length < PAGE_SIZE) return;
			}
		} finally {
			if (gen === this.#gen) this.#polling = false;
		}
	}

	#startTimer() {
		this.#stopTimer();
		this.#pollTimer = setInterval(() => void this.#poll(), CHAT_POLL_MS);
	}

	#stopTimer() {
		if (this.#pollTimer) clearInterval(this.#pollTimer);
		this.#pollTimer = null;
	}

	#onVisibilityChange = () => {
		if (!this.#open) return;
		if (this.#hidden()) {
			this.#stopTimer();
			return;
		}
		void this.#poll();
		void this.#loadSummary();
		this.#startTimer();
	};
}
