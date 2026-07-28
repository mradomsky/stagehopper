import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { saveGoogleAuth } from '$lib/stagehopper/storage.js';
import type { FestivalRecord } from '$lib/stagehopper/types.js';

const saveFestivals = vi.fn();
const fetchMock = vi.fn();

vi.mock('$lib/stagehopper/api.js', () => ({
	saveFestivals: (...args: unknown[]) => saveFestivals(...args)
}));

const { default: AdminFestivalsPage } = await import('./admin/festivals/+page.svelte');

const SEED: FestivalRecord[] = [
	{
		id: 'tmr26',
		name: 'Tomorrowland 2026 – Week 1',
		location: 'Boom, Belgium',
		startDate: '2026-07-17',
		endDate: '2026-07-20',
		accent: 'red',
		emoji: '🎪'
	},
	{
		id: 'ps26',
		name: 'Primavera Sound Barcelona 2026',
		location: 'Barcelona',
		startDate: '2026-06-04',
		endDate: '2026-06-06',
		accent: 'blue',
		emoji: '🌊'
	}
];

function jsonResponse(body: unknown, status = 200) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function rowFor(name: string) {
	return screen.getByText(new RegExp(name)).closest('tr');
}

async function renderLoaded() {
	const result = render(AdminFestivalsPage);
	await waitFor(() => expect(screen.getByText('New festival')).toBeEnabled());
	return result;
}

beforeEach(() => {
	saveGoogleAuth({ idToken: 'tok', sub: '1', name: 'Admin', givenName: 'Admin' });
	fetchMock.mockReset().mockResolvedValue(jsonResponse(SEED));
	vi.stubGlobal('fetch', fetchMock);
	saveFestivals.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe('admin festivals page — loading', () => {
	it('fetches the public festival data, not an admin endpoint', async () => {
		await renderLoaded();

		expect(fetchMock).toHaveBeenCalledWith('/data/festivals.json');
	});

	it('lists every fetched festival', async () => {
		await renderLoaded();

		for (const festival of SEED) {
			expect(screen.getByText(new RegExp(festival.name))).toBeInTheDocument();
		}
	});

	it('falls back to the compiled defaults when the fetch fails', async () => {
		fetchMock.mockRejectedValue(new TypeError('offline'));

		await renderLoaded();

		expect(screen.getByText(/Tomorrowland/)).toBeInTheDocument();
		expect(screen.getByText(/Could not load the festival list/)).toBeInTheDocument();
	});
});

describe('admin festivals page — create', () => {
	it('saves a new festival with a generated id and shows it once the write succeeds', async () => {
		saveFestivals.mockResolvedValue({
			ok: true,
			data: { ok: true, festivals: [...SEED, { id: 'testfest', name: 'Test Fest 2027' }] }
		});
		await renderLoaded();

		await fireEvent.click(screen.getByRole('button', { name: 'New festival' }));
		expect(screen.queryByText(/frozen/)).not.toBeInTheDocument();

		await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Test Fest 2027' } });
		await fireEvent.input(screen.getByLabelText('Location'), { target: { value: 'Testville' } });
		await fireEvent.input(screen.getByLabelText('Start date'), {
			target: { value: '2027-01-01' }
		});
		await fireEvent.input(screen.getByLabelText('End date'), { target: { value: '2027-01-03' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
		expect(screen.getByText(/Test Fest 2027/)).toBeInTheDocument();

		const [idToken, sentFestivals] = saveFestivals.mock.calls[0] as [string, FestivalRecord[]];
		expect(idToken).toBe('tok');
		expect(sentFestivals).toHaveLength(3);
		expect(sentFestivals[2]?.id).toMatch(/^[a-z0-9]{2,10}$/);
	});

	it('will not save a festival missing required fields', async () => {
		await renderLoaded();

		await fireEvent.click(screen.getByRole('button', { name: 'New festival' }));

		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
	});

	it('will not save when the end date is before the start date', async () => {
		await renderLoaded();

		await fireEvent.click(screen.getByRole('button', { name: 'New festival' }));
		await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Bad Dates' } });
		await fireEvent.input(screen.getByLabelText('Location'), { target: { value: 'Nowhere' } });
		await fireEvent.input(screen.getByLabelText('Start date'), {
			target: { value: '2027-01-10' }
		});
		await fireEvent.input(screen.getByLabelText('End date'), { target: { value: '2027-01-01' } });

		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
	});

	it('shows an error and keeps the form open when the save fails', async () => {
		saveFestivals.mockResolvedValue({ ok: false, unauthorized: false, status: 500 });
		await renderLoaded();

		await fireEvent.click(screen.getByRole('button', { name: 'New festival' }));
		await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Test Fest' } });
		await fireEvent.input(screen.getByLabelText('Location'), { target: { value: 'Testville' } });
		await fireEvent.input(screen.getByLabelText('Start date'), {
			target: { value: '2027-01-01' }
		});
		await fireEvent.input(screen.getByLabelText('End date'), { target: { value: '2027-01-03' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() =>
			expect(screen.getByText('Could not save changes. Please try again.')).toBeInTheDocument()
		);
		expect(screen.getByRole('dialog')).toBeInTheDocument();
	});
});

describe('admin festivals page — edit', () => {
	it('opens pre-filled, with the id frozen', async () => {
		await renderLoaded();
		const target = SEED[0]!;

		await fireEvent.click(within(rowFor(target.name)!).getByRole('button', { name: 'Edit' }));

		expect(screen.getByLabelText('Name')).toHaveValue(target.name);
		expect(screen.getByLabelText('Location')).toHaveValue(target.location);
		expect(screen.getByText(new RegExp(target.id))).toBeInTheDocument();
	});

	it('saves an edited festival with its id unchanged', async () => {
		const target = SEED[0]!;
		const updated = { ...target, location: 'Updated location' };
		saveFestivals.mockResolvedValue({
			ok: true,
			data: { ok: true, festivals: [updated, SEED[1]!] }
		});
		await renderLoaded();

		await fireEvent.click(within(rowFor(target.name)!).getByRole('button', { name: 'Edit' }));
		await fireEvent.input(screen.getByLabelText('Location'), {
			target: { value: 'Updated location' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => expect(screen.getByText('Updated location')).toBeInTheDocument());
		const [, sentFestivals] = saveFestivals.mock.calls[0] as [string, FestivalRecord[]];
		expect(sentFestivals.find((f) => f.id === target.id)?.id).toBe(target.id);
	});
});

describe('admin festivals page — delete', () => {
	it('deletes a festival after confirming', async () => {
		saveFestivals.mockResolvedValue({ ok: true, data: { ok: true, festivals: [SEED[1]!] } });
		await renderLoaded();
		const target = SEED[0]!;

		await fireEvent.click(within(rowFor(target.name)!).getByRole('button', { name: 'Delete' }));
		const dialog = screen.getByRole('dialog', { name: 'Delete festival?' });

		await fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

		await waitFor(() => expect(screen.queryByText(new RegExp(target.name))).not.toBeInTheDocument());
		const [, sentFestivals] = saveFestivals.mock.calls[0] as [string, FestivalRecord[]];
		expect(sentFestivals).toHaveLength(1);
	});

	it('keeps the festival on cancel', async () => {
		await renderLoaded();
		const target = SEED[0]!;

		await fireEvent.click(within(rowFor(target.name)!).getByRole('button', { name: 'Delete' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.getByText(new RegExp(target.name))).toBeInTheDocument();
		expect(saveFestivals).not.toHaveBeenCalled();
	});
});
