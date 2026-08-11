import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	getExistingSubscription,
	getPermission,
	pushSupported,
	requestPermission,
	subscribe,
	unsubscribeLocal,
	urlBase64ToUint8Array
} from './push.js';

// Set up minimal API mocks that jsdom doesn't provide by default
if (!navigator.serviceWorker) {
	Object.defineProperty(navigator, 'serviceWorker', {
		value: {},
		configurable: true
	});
}

if (!window.PushManager) {
	(window as any).PushManager = {};
}

if (!window.Notification) {
	(window as any).Notification = { permission: 'default', requestPermission: () => Promise.resolve('default') };
}

describe('urlBase64ToUint8Array', () => {
	it('converts URL-safe base64 to Uint8Array', () => {
		// Known vector: "Hello" in URL-safe base64 is "SGVsbG8"
		const result = urlBase64ToUint8Array('SGVsbG8');
		const expected = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
		expect(result).toEqual(expected);
	});

	it('handles URL-safe characters (- and _)', () => {
		// Base64 with - and _ (URL-safe variants of + and /)
		const standard = 'AB+/CD';
		const urlSafe = 'AB-_CD';
		const resultStandard = urlBase64ToUint8Array(standard.replace(/\+/g, '-').replace(/\//g, '_'));
		const resultUrlSafe = urlBase64ToUint8Array(urlSafe);
		expect(resultUrlSafe).toEqual(resultStandard);
	});

	it('handles padding', () => {
		// "AA" in base64 is "QUE=" (needs padding)
		const result = urlBase64ToUint8Array('QUE');
		expect(result.length).toBe(2);
		expect(result[0]).toBe(0x41);
		expect(result[1]).toBe(0x41);
	});
});

describe('pushSupported', () => {
	it('returns true when all required APIs are present', () => {
		expect(pushSupported()).toBe(true);
	});

	it('returns false when navigator is unavailable', () => {
		const savedNavigator = global.navigator;
		delete (global as any).navigator;

		expect(pushSupported()).toBe(false);

		Object.defineProperty(global, 'navigator', {
			value: savedNavigator,
			configurable: true
		});
	});

	it('returns false when window is unavailable', () => {
		const savedWindow = global.window;
		delete (global as any).window;

		expect(pushSupported()).toBe(false);

		Object.defineProperty(global, 'window', {
			value: savedWindow,
			configurable: true
		});
	});

	it('returns false when serviceWorker is missing', () => {
		const saved = navigator.serviceWorker;
		delete (navigator as any).serviceWorker;

		expect(pushSupported()).toBe(false);

		Object.defineProperty(navigator, 'serviceWorker', {
			value: saved,
			configurable: true
		});
	});

	it('returns false when PushManager is missing', () => {
		const saved = (window as any).PushManager;
		delete (window as any).PushManager;

		expect(pushSupported()).toBe(false);

		Object.defineProperty(window, 'PushManager', {
			value: saved,
			configurable: true
		});
	});

	it('returns false when Notification is missing', () => {
		const saved = (window as any).Notification;
		delete (window as any).Notification;

		expect(pushSupported()).toBe(false);

		Object.defineProperty(window, 'Notification', {
			value: saved,
			configurable: true
		});
	});
});

describe('getPermission', () => {
	it('returns the current Notification permission', () => {
		expect(['granted', 'denied', 'default']).toContain(getPermission());
	});

	it('returns denied when Notification is unavailable', () => {
		const saved = (window as any).Notification;
		delete (window as any).Notification;

		expect(getPermission()).toBe('denied');

		Object.defineProperty(window, 'Notification', {
			value: saved,
			configurable: true
		});
	});
});

describe('requestPermission', () => {
	it('returns a promise resolving to a permission', async () => {
		const permission = await requestPermission();
		expect(['granted', 'denied', 'default']).toContain(permission);
	});

	it('returns denied when Notification is unavailable', async () => {
		const saved = (window as any).Notification;
		delete (window as any).Notification;

		const result = await requestPermission();
		expect(result).toBe('denied');

		Object.defineProperty(window, 'Notification', {
			value: saved,
			configurable: true
		});
	});
});

describe('subscribe', () => {
	let mockSubscription: any;
	let mockPushManager: any;
	let mockRegistration: any;
	let originalServiceWorker: any;

	beforeEach(() => {
		mockSubscription = {
			endpoint: 'https://example.com/push/abc123',
			toJSON: () => ({
				endpoint: 'https://example.com/push/abc123',
				keys: {
					p256dh: 'key1',
					auth: 'auth1'
				}
			})
		};

		mockPushManager = {
			subscribe: vi.fn().mockResolvedValue(mockSubscription)
		};

		mockRegistration = {
			pushManager: mockPushManager
		};

		originalServiceWorker = navigator.serviceWorker;
		Object.defineProperty(navigator, 'serviceWorker', {
			value: {
				ready: Promise.resolve(mockRegistration)
			},
			configurable: true
		});
	});

	afterEach(() => {
		Object.defineProperty(navigator, 'serviceWorker', {
			value: originalServiceWorker,
			configurable: true
		});
	});

	it('calls pushManager.subscribe with the converted VAPID key', async () => {
		const vapidKey = 'SGVsbG8'; // "Hello" in base64
		await subscribe(vapidKey);

		expect(mockPushManager.subscribe).toHaveBeenCalledWith(
			expect.objectContaining({
				userVisibleOnly: true,
				applicationServerKey: expect.any(Uint8Array)
			})
		);

		const call = mockPushManager.subscribe.mock.calls[0]?.[0];
		expect(call.applicationServerKey).toEqual(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
	});

	it('returns the subscription in JSON form', async () => {
		const result = await subscribe('SGVsbG8');

		expect(result).toEqual({
			endpoint: 'https://example.com/push/abc123',
			keys: {
				p256dh: 'key1',
				auth: 'auth1'
			}
		});
	});

	it('returns null when pushSupported is false', async () => {
		const saved = navigator.serviceWorker;
		delete (navigator as any).serviceWorker;

		const result = await subscribe('SGVsbG8');
		expect(result).toBeNull();

		Object.defineProperty(navigator, 'serviceWorker', {
			value: saved,
			configurable: true
		});
	});

	it('returns null when pushManager.subscribe throws', async () => {
		mockPushManager.subscribe.mockRejectedValue(new Error('subscription failed'));

		const result = await subscribe('SGVsbG8');
		expect(result).toBeNull();
	});

	it('returns null when subscription JSON is missing required fields', async () => {
		mockSubscription.toJSON = () => ({
			endpoint: 'https://example.com/push/abc123'
			// missing keys
		});

		const result = await subscribe('SGVsbG8');
		expect(result).toBeNull();
	});
});

describe('getExistingSubscription', () => {
	let mockSubscription: any;
	let mockPushManager: any;
	let mockRegistration: any;
	let originalServiceWorker: any;

	beforeEach(() => {
		mockSubscription = {
			endpoint: 'https://example.com/push/abc123',
			toJSON: () => ({
				endpoint: 'https://example.com/push/abc123',
				keys: {
					p256dh: 'key1',
					auth: 'auth1'
				}
			})
		};

		mockPushManager = {
			getSubscription: vi.fn().mockResolvedValue(mockSubscription)
		};

		mockRegistration = {
			pushManager: mockPushManager
		};

		originalServiceWorker = navigator.serviceWorker;
		Object.defineProperty(navigator, 'serviceWorker', {
			value: {
				ready: Promise.resolve(mockRegistration)
			},
			configurable: true
		});
	});

	afterEach(() => {
		Object.defineProperty(navigator, 'serviceWorker', {
			value: originalServiceWorker,
			configurable: true
		});
	});

	it('returns the existing subscription', async () => {
		const result = await getExistingSubscription();

		expect(result).toEqual({
			endpoint: 'https://example.com/push/abc123',
			keys: {
				p256dh: 'key1',
				auth: 'auth1'
			}
		});
	});

	it('returns null when no subscription exists', async () => {
		mockPushManager.getSubscription.mockResolvedValue(null);

		const result = await getExistingSubscription();
		expect(result).toBeNull();
	});

	it('returns null when getSubscription throws', async () => {
		mockPushManager.getSubscription.mockRejectedValue(new Error('failed'));

		const result = await getExistingSubscription();
		expect(result).toBeNull();
	});

	it('returns null when pushSupported is false', async () => {
		const saved = navigator.serviceWorker;
		delete (navigator as any).serviceWorker;

		const result = await getExistingSubscription();
		expect(result).toBeNull();

		Object.defineProperty(navigator, 'serviceWorker', {
			value: saved,
			configurable: true
		});
	});
});

describe('unsubscribeLocal', () => {
	let mockSubscription: any;
	let mockPushManager: any;
	let mockRegistration: any;
	let originalServiceWorker: any;

	beforeEach(() => {
		mockSubscription = {
			endpoint: 'https://example.com/push/abc123',
			unsubscribe: vi.fn().mockResolvedValue(true)
		};

		mockPushManager = {
			getSubscription: vi.fn().mockResolvedValue(mockSubscription)
		};

		mockRegistration = {
			pushManager: mockPushManager
		};

		originalServiceWorker = navigator.serviceWorker;
		Object.defineProperty(navigator, 'serviceWorker', {
			value: {
				ready: Promise.resolve(mockRegistration)
			},
			configurable: true
		});
	});

	afterEach(() => {
		Object.defineProperty(navigator, 'serviceWorker', {
			value: originalServiceWorker,
			configurable: true
		});
	});

	it('unsubscribes and returns the endpoint', async () => {
		const result = await unsubscribeLocal();

		expect(mockSubscription.unsubscribe).toHaveBeenCalled();
		expect(result).toBe('https://example.com/push/abc123');
	});

	it('returns null when no subscription exists', async () => {
		mockPushManager.getSubscription.mockResolvedValue(null);

		const result = await unsubscribeLocal();
		expect(result).toBeNull();
	});

	it('returns null when unsubscribe throws', async () => {
		mockSubscription.unsubscribe.mockRejectedValue(new Error('failed'));

		const result = await unsubscribeLocal();
		expect(result).toBeNull();
	});

	it('returns null when pushSupported is false', async () => {
		const saved = navigator.serviceWorker;
		delete (navigator as any).serviceWorker;

		const result = await unsubscribeLocal();
		expect(result).toBeNull();

		Object.defineProperty(navigator, 'serviceWorker', {
			value: saved,
			configurable: true
		});
	});
});
