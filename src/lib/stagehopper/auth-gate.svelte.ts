/**
 * @file Shared "sign in to continue" gate.
 *
 * Several pages want the same shape: try an action, and if the visitor isn't signed in,
 * open Clerk's modal and replay the action once a session appears. Clerk's prebuilt
 * component has no completion callback — it just establishes a session — so replay is
 * driven by watching `auth.user` from an `$effect` in the component (Svelte effects can't
 * be created outside one), wired to {@link AuthGate.handleSignedIn}.
 */

import { auth } from './auth.svelte.js';

export interface AuthGateOptions {
	/** Called once sign-in completes with nothing queued (e.g. a plain "Log in"). */
	onSignedInIdle?: () => void;
}

export class AuthGate {
	open = $state(false);
	error = $state('');

	#pending: (() => void) | null = null;
	#onSignedInIdle?: () => void;

	constructor(options: AuthGateOptions = {}) {
		this.#onSignedInIdle = options.onSignedInIdle;
	}

	/** Run `action` now if signed in; otherwise open the gate and replay it after sign-in. */
	run(action: () => void) {
		if (auth.user) {
			action();
			return;
		}
		this.#pending = action;
		this.error = '';
		this.open = true;
	}

	/** Plain sign-in with nothing queued to replay. */
	promptLogin() {
		this.#pending = null;
		this.error = '';
		this.open = true;
	}

	cancel() {
		this.open = false;
		this.#pending = null;
	}

	/** Call from an `$effect` that watches `auth.user`. */
	handleSignedIn() {
		if (!auth.user || !this.open) return;
		this.error = '';
		this.open = false;
		const action = this.#pending;
		this.#pending = null;
		if (action) action();
		else this.#onSignedInIdle?.();
	}
}
