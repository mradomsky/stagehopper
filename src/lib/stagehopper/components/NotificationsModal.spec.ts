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

// storage.js is NOT mocked — the real (localStorage-backed) endpoint tracking is under test.
import { savePushEndpoint, loadPushEndpoint } from '../storage.js';
import NotificationsModal from './NotificationsModal.svelte';

function renderModal() {
	const onClose = vi.fn();
	return { onClose, ...render(NotificationsModal, { props: { onClose } }) };
}

describe('NotificationsModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		getPermission.mockReturnValue('default');
		ensureFreshGoogleAuth.mockResolvedValue({ idToken: 'tok' });
		getExistingSubscription.mockResolvedValue(null);
		getNotificationSettings.mockResolvedValue({
			ok: true,
			data: { leadMinutes: 15, notifyMaybe: false, enabled: false, subscribedHere: false }
		});
		saveNotificationSettings.mockResolvedValue({ ok: true });
		addPushSubscription.mockResolvedValue({ ok: true });
		removePushSubscription.mockResolvedValue({ ok: true });
	});

	afterEach(() => vi.resetModules());

	it('shows the Safari install instruction on iOS when push is unsupported', async () => {
		pushSupported.mockReturnValue(false);
		const ua = navigator.userAgent;
		Object.defineProperty(navigator, 'userAgent', {
			value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
			configurable: true
		});
		try {
			renderModal();
			expect(await screen.findByText(/Home Screen/i)).toBeInTheDocument();
		} finally {
			Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
		}
	});

	it('shows a generic unavailable note off-iOS when push is unsupported', async () => {
		pushSupported.mockReturnValue(false);
		renderModal();
		expect(await screen.findByText(/aren't available in this browser/i)).toBeInTheDocument();
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
		expect(await screen.findByText(/maybe going/i)).toBeInTheDocument();
	});

	it('never writes settings on activation — going always notifies, so there is nothing to default', async () => {
		pushSupported.mockReturnValue(true);
		requestPermission.mockResolvedValue('granted');
		subscribe.mockResolvedValue({ endpoint: 'https://push/x', keys: { p256dh: 'p', auth: 'a' } });
		addPushSubscription.mockResolvedValue({ ok: true });
		renderModal();

		await fireEvent.click(await screen.findByText(/Turn on for this device/i));

		await waitFor(() => expect(addPushSubscription).toHaveBeenCalled());
		expect(saveNotificationSettings).not.toHaveBeenCalled();
	});

	const LIVE_SUB = { endpoint: 'https://push/x', keys: { p256dh: 'p', auth: 'a' } };

	it('treats a live browser subscription as active even when the server has not caught up', async () => {
		pushSupported.mockReturnValue(true);
		getExistingSubscription.mockResolvedValue(LIVE_SUB);
		// Server doesn't list this endpoint (e.g. iOS rotated it) — the device is still on.
		getNotificationSettings.mockResolvedValue({
			ok: true,
			data: { leadMinutes: 15, notifyMaybe: false, enabled: true, subscribedHere: false }
		});
		renderModal();

		// Shows the preference controls (active), not the "Turn on" button.
		expect(await screen.findByText(/maybe going/i)).toBeInTheDocument();
		// Self-heals: the live endpoint gets registered so the notifier can reach it.
		await waitFor(() => expect(addPushSubscription).toHaveBeenCalledWith('tok', LIVE_SUB));
	});

	it('does not re-register when the server already lists the live subscription', async () => {
		pushSupported.mockReturnValue(true);
		getExistingSubscription.mockResolvedValue(LIVE_SUB);
		getNotificationSettings.mockResolvedValue({
			ok: true,
			data: { leadMinutes: 15, notifyMaybe: false, enabled: true, subscribedHere: true }
		});
		renderModal();

		expect(await screen.findByText(/maybe going/i)).toBeInTheDocument();
		expect(addPushSubscription).not.toHaveBeenCalled();
	});

	it('drops the superseded endpoint when the subscription has rotated', async () => {
		savePushEndpoint('https://push/old');
		pushSupported.mockReturnValue(true);
		getExistingSubscription.mockResolvedValue(LIVE_SUB);
		getNotificationSettings.mockResolvedValue({
			ok: true,
			data: { leadMinutes: 15, notifyMaybe: false, enabled: true, subscribedHere: false }
		});
		renderModal();

		await waitFor(() => expect(removePushSubscription).toHaveBeenCalledWith('tok', 'https://push/old'));
		expect(addPushSubscription).toHaveBeenCalledWith('tok', LIVE_SUB);
		expect(loadPushEndpoint()).toBe('https://push/x');
	});

	it('records the registered endpoint on activation so a later rotation can prune it', async () => {
		pushSupported.mockReturnValue(true);
		requestPermission.mockResolvedValue('granted');
		subscribe.mockResolvedValue(LIVE_SUB);
		renderModal();

		await fireEvent.click(await screen.findByText(/Turn on for this device/i));

		await waitFor(() => expect(loadPushEndpoint()).toBe('https://push/x'));
	});

	/** A subscribed device with one category on — the state that shows the preference controls. */
	function wireSubscribed() {
		pushSupported.mockReturnValue(true);
		// A live browser subscription the server already knows about: "active" on this device.
		getExistingSubscription.mockResolvedValue(LIVE_SUB);
		getNotificationSettings.mockResolvedValue({
			ok: true,
			data: { leadMinutes: 15, notifyMaybe: false, enabled: true, subscribedHere: true }
		});
	}

	it('offers no "Going" control at all — going always notifies, with nothing to toggle', async () => {
		wireSubscribed();
		renderModal();

		await screen.findByText(/maybe going/i);
		expect(screen.queryByText(/Notify for "Going"/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/^Going$/i)).not.toBeInTheDocument();
		expect(screen.getAllByRole('checkbox')).toHaveLength(1);
	});

	it('stages a lead-time change without writing until it is confirmed', async () => {
		wireSubscribed();
		renderModal();

		await fireEvent.click(await screen.findByText('30m'));
		expect(saveNotificationSettings).not.toHaveBeenCalled();

		await fireEvent.click(await screen.findByText(/Confirm changes/i));

		await waitFor(() =>
			expect(saveNotificationSettings).toHaveBeenCalledWith('tok', {
				leadMinutes: 30,
				notifyMaybe: false
			})
		);
	});

	it('offers no confirm button until something actually changes', async () => {
		wireSubscribed();
		renderModal();

		await screen.findByText('30m');
		expect(screen.queryByText(/Confirm changes/i)).not.toBeInTheDocument();
	});

	it('hides the confirm button again once the save succeeds', async () => {
		wireSubscribed();
		renderModal();

		await fireEvent.click(await screen.findByText('30m'));
		await fireEvent.click(await screen.findByText(/Confirm changes/i));

		await waitFor(() => expect(screen.queryByText(/Confirm changes/i)).not.toBeInTheDocument());
	});

	it('reverts to clean when the draft is edited back to the stored values', async () => {
		wireSubscribed();
		renderModal();

		await fireEvent.click(await screen.findByText('30m'));
		expect(await screen.findByText(/Confirm changes/i)).toBeInTheDocument();

		await fireEvent.click(screen.getByText('15m'));

		await waitFor(() => expect(screen.queryByText(/Confirm changes/i)).not.toBeInTheDocument());
		expect(saveNotificationSettings).not.toHaveBeenCalled();
	});

	it('surfaces a failed save and keeps the changes pending', async () => {
		wireSubscribed();
		saveNotificationSettings.mockResolvedValue({ ok: false });
		renderModal();

		await fireEvent.click(await screen.findByText('30m'));
		await fireEvent.click(await screen.findByText(/Confirm changes/i));

		expect(await screen.findByText(/Could not save your notification settings/i)).toBeInTheDocument();
		// Still dirty: the user must be able to retry rather than lose the edit silently.
		expect(screen.getByText(/Confirm changes/i)).toBeInTheDocument();
	});
});
