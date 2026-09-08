import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from './auth.svelte.js';

/**
 * The gate reads exactly one thing about the world — whether somebody is signed in — so the
 * fake is that one field. Clerk's own module is never loaded here.
 */
const session = vi.hoisted(() => ({ user: null as AuthUser | null | undefined }));
vi.mock('./auth.svelte.js', () => ({ auth: session }));

import { AuthGate } from './auth-gate.svelte.js';

const SIGNED_IN: AuthUser = { id: 'u1', name: 'Alex', givenName: 'Alex' };

beforeEach(() => {
	session.user = null;
});

describe('AuthGate.run', () => {
	it('runs the action straight away when somebody is signed in', () => {
		session.user = SIGNED_IN;
		const gate = new AuthGate();
		const action = vi.fn();

		gate.run(action);

		expect(action).toHaveBeenCalledOnce();
		expect(gate.open).toBe(false);
	});

	it('opens the gate and holds the action back when nobody is', () => {
		const gate = new AuthGate();
		const action = vi.fn();

		gate.run(action);

		expect(action).not.toHaveBeenCalled();
		expect(gate.open).toBe(true);
	});
});

describe('AuthGate.handleSignedIn', () => {
	it('replays the held action once a session appears, and closes', () => {
		const gate = new AuthGate();
		const action = vi.fn();
		gate.run(action);

		session.user = SIGNED_IN;
		gate.handleSignedIn();

		expect(action).toHaveBeenCalledOnce();
		expect(gate.open).toBe(false);
	});

	it('replays only once, however often the effect re-fires', () => {
		// The caller drives this from an $effect watching auth.user, which can run again for
		// reasons that have nothing to do with signing in.
		const gate = new AuthGate();
		const action = vi.fn();
		gate.run(action);
		session.user = SIGNED_IN;

		gate.handleSignedIn();
		gate.handleSignedIn();
		gate.handleSignedIn();

		expect(action).toHaveBeenCalledOnce();
	});

	it('does nothing while the visitor is still signed out', () => {
		const gate = new AuthGate();
		const action = vi.fn();
		gate.run(action);

		gate.handleSignedIn();

		expect(action).not.toHaveBeenCalled();
		expect(gate.open).toBe(true);
	});

	it('does nothing when the gate was never opened', () => {
		// A session can appear without this gate having asked for one — signing in from
		// somewhere else on the page must not fire an action this gate is not holding.
		session.user = SIGNED_IN;
		const onSignedInIdle = vi.fn();
		const gate = new AuthGate({ onSignedInIdle });

		gate.handleSignedIn();

		expect(onSignedInIdle).not.toHaveBeenCalled();
		expect(gate.open).toBe(false);
	});
});

describe('AuthGate.promptLogin', () => {
	it('opens with nothing queued, and reports the idle sign-in', () => {
		const onSignedInIdle = vi.fn();
		const gate = new AuthGate({ onSignedInIdle });

		gate.promptLogin();
		expect(gate.open).toBe(true);

		session.user = SIGNED_IN;
		gate.handleSignedIn();

		expect(onSignedInIdle).toHaveBeenCalledOnce();
		expect(gate.open).toBe(false);
	});

	it('drops an action queued by an earlier run', () => {
		const onSignedInIdle = vi.fn();
		const gate = new AuthGate({ onSignedInIdle });
		const action = vi.fn();
		gate.run(action);

		gate.promptLogin();
		session.user = SIGNED_IN;
		gate.handleSignedIn();

		expect(action).not.toHaveBeenCalled();
		expect(onSignedInIdle).toHaveBeenCalledOnce();
	});

	it('reports nothing when no idle handler was given', () => {
		const gate = new AuthGate();
		gate.promptLogin();
		session.user = SIGNED_IN;

		expect(() => gate.handleSignedIn()).not.toThrow();
		expect(gate.open).toBe(false);
	});
});

describe('AuthGate.cancel', () => {
	it('closes the gate and forgets the held action', () => {
		const gate = new AuthGate();
		const action = vi.fn();
		gate.run(action);

		gate.cancel();
		expect(gate.open).toBe(false);

		// Signing in later must not replay something the visitor backed out of.
		session.user = SIGNED_IN;
		gate.handleSignedIn();

		expect(action).not.toHaveBeenCalled();
	});
});
