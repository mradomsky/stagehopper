/**
 * @file Browser push notification helpers. All functions are SSR-safe and defensive.
 *
 * Callers should always check {@link pushSupported} before attempting to use any
 * subscription-related functions, though each function gracefully handles missing APIs.
 */

/**
 * Whether the browser supports push notifications.
 * Checks for required APIs: serviceWorker, PushManager, Notification.
 */
export function pushSupported(): boolean {
	if (typeof navigator === 'undefined' || typeof window === 'undefined') {
		return false;
	}
	return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/**
 * Convert a VAPID public key from URL-safe base64 to a Uint8Array for browser subscription.
 * Raises if the input is invalid.
 */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
	const padding = '='.repeat((4 - (base64.length % 4)) % 4);
	const base64Padded = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
	const binaryString = atob(base64Padded);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes;
}

/**
 * Read the user's current Notification permission status.
 * Returns 'granted', 'denied', or 'default' (not yet decided).
 */
export function getPermission(): NotificationPermission {
	if (typeof Notification === 'undefined') {
		return 'denied';
	}
	return Notification.permission;
}

/**
 * Request permission from the user to display notifications.
 * Returns the user's choice: 'granted', 'denied', or 'default'.
 */
export async function requestPermission(): Promise<NotificationPermission> {
	if (typeof Notification === 'undefined') {
		return 'denied';
	}
	return Notification.requestPermission();
}

/**
 * A narrowed push subscription JSON shape containing only the fields we use.
 */
export interface PushSubscriptionJSON {
	endpoint: string;
	keys: {
		p256dh: string;
		auth: string;
	};
}

/**
 * Create a new push subscription for the given VAPID public key.
 * Requires notification permission to be 'granted' first.
 * Resolves to the subscription in JSON form, ready to send to the server.
 * Returns null if the browser doesn't support push or the subscription fails.
 */
export async function subscribe(vapidPublicKey: string): Promise<PushSubscriptionJSON | null> {
	if (!pushSupported()) {
		return null;
	}

	try {
		const registration = await navigator.serviceWorker.ready;
		if (!registration.pushManager) {
			return null;
		}

		const subscription = await registration.pushManager.subscribe({
			userVisibleOnly: true,
			// Cast: lib.dom types applicationServerKey as BufferSource (ArrayBuffer-backed);
			// a plain Uint8Array<ArrayBufferLike> is byte-compatible at runtime.
			applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource
		});

		const json = subscription.toJSON();
		if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
			return null;
		}

		return {
			endpoint: json.endpoint,
			keys: {
				p256dh: json.keys.p256dh,
				auth: json.keys.auth
			}
		};
	} catch {
		return null;
	}
}

/**
 * Fetch any existing push subscription for the service worker.
 * Returns the subscription in JSON form, or null if none exists.
 */
export async function getExistingSubscription(): Promise<PushSubscriptionJSON | null> {
	if (!pushSupported()) {
		return null;
	}

	try {
		const registration = await navigator.serviceWorker.ready;
		if (!registration.pushManager) {
			return null;
		}

		const subscription = await registration.pushManager.getSubscription();
		if (!subscription) {
			return null;
		}

		const json = subscription.toJSON();
		if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
			return null;
		}

		return {
			endpoint: json.endpoint,
			keys: {
				p256dh: json.keys.p256dh,
				auth: json.keys.auth
			}
		};
	} catch {
		return null;
	}
}

/**
 * Unsubscribe from push notifications. Returns the endpoint that was removed,
 * or null if there was no subscription or the operation failed.
 * Use the returned endpoint to tell the server about the unsubscription.
 */
export async function unsubscribeLocal(): Promise<string | null> {
	if (!pushSupported()) {
		return null;
	}

	try {
		const registration = await navigator.serviceWorker.ready;
		if (!registration.pushManager) {
			return null;
		}

		const subscription = await registration.pushManager.getSubscription();
		if (!subscription) {
			return null;
		}

		const endpoint = subscription.endpoint;
		await subscription.unsubscribe();
		return endpoint;
	} catch {
		return null;
	}
}
