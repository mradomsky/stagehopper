import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/svelte';

// The modal is glue over push/api/auth; mock those so tests drive its branches directly.
// vi.hoisted so the fns exist when the (statically imported) component pulls the mocks.
const {
	pushSupported,
	getPermission,
	requestPermission,
	subscribe,
	getExistingSubscription,
	unsubscribeLocal,
	ensureFreshGoogleAuth,
	getNotificationSettings,
	saveNotificationSettings,
	addPushSubscription,
	removePushSubscription
} = vi.hoisted(() => ({
	pushSupported: vi.fn(),
	getPermission: vi.fn(() => 'default'),
	requestPermission: vi.fn(),
	subscribe: vi.fn(),
	getExistingSubscription: vi.fn(),
	unsubscribeLocal: vi.fn(),
	ensureFreshGoogleAuth: vi.fn(),
	getNotificationSettings: vi.fn(),
	saveNotificationSettings: vi.fn(),
	addPushSubscription: vi.fn(),
	removePushSubscription: vi.fn()
}));

vi.mock('../push.js', () => ({
	pushSupported,
	getPermission,
	requestPermission,
	subscribe,
	getExistingSubscription,
	unsubscribeLocal
}));

vi.mock('../auth.js', () => ({ ensureFreshGoogleAuth }));

vi.mock('../api.js', () => ({
	getNotificationSettings,
	saveNotificationSettings,
	addPushSubscription,
	removePushSubscription
}));

import NotificationsModal from './NotificationsModal.svelte';

function renderModal() {
	const onClose = vi.fn();
	return { onClose, ...render(NotificationsModal, { props: { onClose } }) };
}

describe('NotificationsModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getPermission.mockReturnValue('default');
		ensureFreshGoogleAuth.mockResolvedValue({ idToken: 'tok' });
		getExistingSubscription.mockResolvedValue(null);
		getNotificationSettings.mockResolvedValue({
			ok: true,
			data: { leadMinutes: 15, notifyAttending: false, notifyMaybe: false, enabled: false, subscribedHere: false }
		});
		saveNotificationSettings.mockResolvedValue({ ok: true });
	});

	afterEach(() => vi.resetModules());

	it('shows the install hint when push is unsupported', async () => {
		pushSupported.mockReturnValue(false);
		renderModal();
		expect(await screen.findByText(/Home Screen/i)).toBeInTheDocument();
	});

	it('prompts to sign in when there is no Google identity', async () => {
		pushSupported.mockReturnValue(true);
		ensureFreshGoogleAuth.mockResolvedValue(null);
		renderModal();
		expect(await screen.findByText(/Sign in to enable/i)).toBeInTheDocument();
	});

	it('offers activation for a supported, signed-in, unsubscribed device', async () => {
		pushSupported.mockReturnValue(true);
		renderModal();
		expect(await screen.findByText(/Turn on for this device/i)).toBeInTheDocument();
	});

	it('subscribes this device and reveals the category switches on activation', async () => {
		pushSupported.mockReturnValue(true);
		requestPermission.mockResolvedValue('granted');
		subscribe.mockResolvedValue({ endpoint: 'https://push/x', keys: { p256dh: 'p', auth: 'a' } });
		addPushSubscription.mockResolvedValue({ ok: true });
		renderModal();

		const button = await screen.findByText(/Turn on for this device/i);
		await fireEvent.click(button);

		await waitFor(() => expect(addPushSubscription).toHaveBeenCalledWith('tok', {
			endpoint: 'https://push/x',
			keys: { p256dh: 'p', auth: 'a' }
		}));
		expect(await screen.findByText(/Notify for "Going"/i)).toBeInTheDocument();
	});

	it('defaults "Going" on when a device with no category is activated', async () => {
		pushSupported.mockReturnValue(true);
		requestPermission.mockResolvedValue('granted');
		subscribe.mockResolvedValue({ endpoint: 'https://push/x', keys: { p256dh: 'p', auth: 'a' } });
		addPushSubscription.mockResolvedValue({ ok: true });
		renderModal();

		await fireEvent.click(await screen.findByText(/Turn on for this device/i));

		await waitFor(() =>
			expect(saveNotificationSettings).toHaveBeenCalledWith('tok', {
				leadMinutes: 15,
				notifyAttending: true,
				notifyMaybe: false
			})
		);
	});

	it('leaves existing categories alone on re-enable', async () => {
		pushSupported.mockReturnValue(true);
		requestPermission.mockResolvedValue('granted');
		subscribe.mockResolvedValue({ endpoint: 'https://push/x', keys: { p256dh: 'p', auth: 'a' } });
		addPushSubscription.mockResolvedValue({ ok: true });
		getNotificationSettings.mockResolvedValue({
			ok: true,
			data: { leadMinutes: 15, notifyAttending: false, notifyMaybe: true, enabled: false, subscribedHere: false }
		});
		renderModal();

		await fireEvent.click(await screen.findByText(/Turn on for this device/i));

		await waitFor(() => expect(addPushSubscription).toHaveBeenCalled());
		expect(saveNotificationSettings).not.toHaveBeenCalled();
	});

	it('persists a lead-time change once the device is subscribed', async () => {
		pushSupported.mockReturnValue(true);
		getNotificationSettings.mockResolvedValue({
			ok: true,
			data: { leadMinutes: 15, notifyAttending: true, notifyMaybe: false, enabled: true, subscribedHere: true }
		});
		saveNotificationSettings.mockResolvedValue({ ok: true });
		renderModal();

		const preset = await screen.findByText('30m');
		await fireEvent.click(preset);

		await waitFor(() =>
			expect(saveNotificationSettings).toHaveBeenCalledWith('tok', {
				leadMinutes: 30,
				notifyAttending: true,
				notifyMaybe: false
			})
		);
	});
});
