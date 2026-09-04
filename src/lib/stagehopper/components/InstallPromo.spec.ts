import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';

// Spy on the three side-effecting functions but keep the real stores (canNativeInstall,
// installPromoOpen) so the component's reactive subscriptions behave normally.
const { detectInstallContext, triggerNativeInstall, markInstallPromoSeen } = vi.hoisted(() => ({
	detectInstallContext: vi.fn(),
	triggerNativeInstall: vi.fn(),
	markInstallPromoSeen: vi.fn()
}));

vi.mock('../install.js', async (importActual) => {
	const actual = await importActual<typeof import('../install.js')>();
	return { ...actual, detectInstallContext, triggerNativeInstall, markInstallPromoSeen };
});

import InstallPromo from './InstallPromo.svelte';
import { canNativeInstall, installPromoOpen } from '../install.js';

describe('InstallPromo', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		canNativeInstall.set(false);
		installPromoOpen.set(true);
		triggerNativeInstall.mockResolvedValue(true);
	});

	afterEach(() => vi.resetModules());

	it('always lists the install benefits', () => {
		detectInstallContext.mockReturnValue({ platform: 'ios', isStandalone: false });
		render(InstallPromo);
		expect(screen.getByText(/Stay signed in/i)).toBeInTheDocument();
		expect(screen.getByText(/Set reminders/i)).toBeInTheDocument();
		expect(screen.getByText(/One tap/i)).toBeInTheDocument();
	});

	it('on iOS reveals the Safari steps and Apple link when Install is tapped', async () => {
		detectInstallContext.mockReturnValue({ platform: 'ios', isStandalone: false });
		render(InstallPromo);

		// Steps hidden until asked for.
		expect(screen.queryByText(/Add to Home Screen/i)).not.toBeInTheDocument();

		await fireEvent.click(screen.getByRole('button', { name: 'Install' }));

		expect(screen.getByText(/Share/)).toBeInTheDocument();
		expect(screen.getByText(/Add to Home Screen/i)).toBeInTheDocument();
		const link = screen.getByRole('link', { name: /Apple Support page/i });
		expect(link).toHaveAttribute('target', '_blank');
		expect(link).toHaveAttribute('rel', 'noopener');
		// No native install is attempted on iOS.
		expect(triggerNativeInstall).not.toHaveBeenCalled();
	});

	it('on Android with a native prompt, Install fires it then dismisses', async () => {
		detectInstallContext.mockReturnValue({
			platform: 'android',
			isStandalone: false
		});
		canNativeInstall.set(true);
		render(InstallPromo);

		expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
		await fireEvent.click(screen.getByRole('button', { name: 'Install' }));

		await waitFor(() => expect(triggerNativeInstall).toHaveBeenCalledTimes(1));
		expect(markInstallPromoSeen).toHaveBeenCalledTimes(1);
		expect(get(installPromoOpen)).toBe(false);
	});

	it('on Android without a native prompt, shows the menu fallback and no Install button', () => {
		detectInstallContext.mockReturnValue({
			platform: 'android',
			isStandalone: false
		});
		render(InstallPromo);

		expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
		expect(screen.getByText(/Add to Home screen/i)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument();
	});

	it('dismissing marks the promo seen and closes it', async () => {
		detectInstallContext.mockReturnValue({ platform: 'ios', isStandalone: false });
		render(InstallPromo);

		await fireEvent.click(screen.getByRole('button', { name: 'Got it' }));

		expect(markInstallPromoSeen).toHaveBeenCalledTimes(1);
		expect(get(installPromoOpen)).toBe(false);
	});
});
