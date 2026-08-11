/**
 * @file Install / "add to Home Screen" (PWA) context and the fresh-login install promo.
 *
 * Two surfaces consume this: the once-per-device login promo ({@link InstallPromo}) and the
 * NotificationsModal's "not supported" note. Both need the same truths — which platform, is the
 * app already installed (standalone), can this browser push right now — so the detection lives
 * here once and the copy strings are shared to keep the two surfaces from drifting.
 */

import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { pushSupported } from './push.js';

export type InstallPlatform = 'ios' | 'android' | 'desktop';

export interface InstallContext {
	platform: InstallPlatform;
	/** True when launched from an installed PWA (Home Screen / app window), not a browser tab. */
	isStandalone: boolean;
	/** True when this browser can subscribe to push *as it is now* (no install needed). */
	canPushNow: boolean;
}

/**
 * The one iOS instruction, shared by the promo and the NotificationsModal note so the wording
 * can never diverge. Deliberately says "in Safari" for everyone: on iOS only Safari's engine can
 * add a working PWA, so this is the correct advice for Chrome/Firefox users too, and a harmless
 * "you're already here" for Safari users. See the Q5 decision — no brittle browser sniffing.
 */
export const IOS_INSTALL_INSTRUCTION =
	'To get notifications on iPhone, open StageHopper in Safari, then tap Share → Add to Home Screen.';

/** localStorage key: the promo is shown at most once per device (set on dismiss/action). */
const PROMO_SEEN_KEY = 'sh-install-promo-seen';

/** Whether push is *possible on this device at all*, ignoring current permission/subscription. */
function readStandalone(): boolean {
	// iOS Safari predates display-mode and only exposes the legacy navigator.standalone flag.
	const iosStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
	const displayStandalone =
		typeof window.matchMedia === 'function' &&
		window.matchMedia('(display-mode: standalone)').matches;
	return iosStandalone || displayStandalone;
}

/**
 * Classify the current device for install guidance. SSR-safe: returns a desktop/no-op shape when
 * there's no `window`, so callers never branch on `browser` themselves.
 */
export function detectInstallContext(): InstallContext {
	if (!browser) {
		return { platform: 'desktop', isStandalone: false, canPushNow: false };
	}
	const ua = navigator.userAgent || '';
	// iPadOS 13+ reports a desktop-Safari UA, so a touch-capable "Macintosh" is really an iPad.
	const isIOS =
		/iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
	const isAndroid = /android/i.test(ua);
	const platform: InstallPlatform = isIOS ? 'ios' : isAndroid ? 'android' : 'desktop';

	return { platform, isStandalone: readStandalone(), canPushNow: pushSupported() };
}

// ---- beforeinstallprompt (Android native install) ----

/**
 * The subset of the non-standard beforeinstallprompt event we use. Chrome fires it when the app
 * meets install criteria (manifest + icons + service worker); we stash it and replay it on the
 * promo's Install button. It can fire before any component mounts, hence a module-level capture.
 */
interface BeforeInstallPromptEvent extends Event {
	prompt: () => Promise<void>;
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;
/** True once a native Android install prompt is available to replay. */
export const canNativeInstall = writable(false);

/**
 * Start listening for the native install prompt. Call once, early (app layout onMount). Safe to
 * call more than once — listeners are attached only on the first browser invocation.
 */
let initialised = false;
export function initInstallPrompt(): void {
	if (!browser || initialised) return;
	initialised = true;
	window.addEventListener('beforeinstallprompt', (event) => {
		// Suppress Chrome's mini-infobar so the promo owns the install moment.
		event.preventDefault();
		deferredInstallPrompt = event as BeforeInstallPromptEvent;
		canNativeInstall.set(true);
	});
	window.addEventListener('appinstalled', () => {
		deferredInstallPrompt = null;
		canNativeInstall.set(false);
		// Installed for real — never nag on this device again.
		markInstallPromoSeen();
	});
}

/**
 * Replay the captured native install prompt. Returns true if the user accepted. A no-op returning
 * false when no prompt was captured (e.g. Firefox, or criteria unmet). Single-use: Chrome only
 * lets each captured event be prompted once.
 */
export async function triggerNativeInstall(): Promise<boolean> {
	if (!deferredInstallPrompt) return false;
	const event = deferredInstallPrompt;
	deferredInstallPrompt = null;
	canNativeInstall.set(false);
	await event.prompt();
	const { outcome } = await event.userChoice;
	return outcome === 'accepted';
}

// ---- Once-per-device promo gating ----

export function installPromoSeen(): boolean {
	if (!browser) return true;
	try {
		return localStorage.getItem(PROMO_SEEN_KEY) === '1';
	} catch {
		// Storage blocked (private mode / cookies off): treat as unseen but never crash the flow.
		return false;
	}
}

export function markInstallPromoSeen(): void {
	if (!browser) return;
	try {
		localStorage.setItem(PROMO_SEEN_KEY, '1');
	} catch {
		// Nothing to do — worst case the promo shows again next login on this locked-down device.
	}
}

/**
 * Whether a freshly-logged-in user on this device should see the promo. Hard suppressors: already
 * installed (standalone), desktop, or already seen. Sign-in is enforced by the caller (it fires
 * from post-login sites only).
 */
export function shouldShowInstallPromo(): boolean {
	if (installPromoSeen()) return false;
	const ctx = detectInstallContext();
	return !ctx.isStandalone && ctx.platform !== 'desktop';
}

/** Open state for the single app-level {@link InstallPromo} instance. */
export const installPromoOpen = writable(false);

/** Open the promo iff this device is eligible. Called from login-success sites. */
export function maybeOpenInstallPromo(): void {
	if (shouldShowInstallPromo()) installPromoOpen.set(true);
}
