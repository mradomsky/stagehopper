import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { saveGoogleAuth } from '$lib/stagehopper/storage.js';
import type { FestivalRecord } from '$lib/stagehopper/types.js';

const saveFestivals = vi.fn();
const presignFestivalImage = vi.fn();
const uploadToPresignedUrl = vi.fn();
const importFestivalTimetable = vi.fn();
const downscaleImage = vi.fn();
const fetchMock = vi.fn();

vi.mock('$lib/stagehopper/api.js', () => ({
	saveFestivals: (...args: unknown[]) => saveFestivals(...args),
	presignFestivalImage: (...args: unknown[]) => presignFestivalImage(...args),
	uploadToPresignedUrl: (...args: unknown[]) => uploadToPresignedUrl(...args),
	importFestivalTimetable: (...args: unknown[]) => importFestivalTimetable(...args)
}));

vi.mock('$lib/stagehopper/admin/image-upload.js', () => ({
	downscaleImage: (...args: unknown[]) => downscaleImage(...args)
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
	presignFestivalImage.mockReset();
	uploadToPresignedUrl.mockReset();
	downscaleImage.mockReset().mockImplementation(async (file: File) => file);
	importFestivalTimetable.mockReset();
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

	it('links each row to its per-performance timetable editor', async () => {
		await renderLoaded();

		for (const festival of SEED) {
			expect(within(rowFor(festival.name)!).getByRole('link', { name: 'Edit timetable' })).toHaveAttribute(
				'href',
				`/admin/festivals/${festival.id}/timetable`
			);
		}
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

describe('admin festivals page — cover image', () => {
	function imageFile() {
		return new File(['bytes'], 'cover.jpg', { type: 'image/jpeg' });
	}

	it('has nowhere to upload to for a festival that has not been saved yet', async () => {
		await renderLoaded();

		await fireEvent.click(screen.getByRole('button', { name: 'New festival' }));

		expect(screen.getByText('Save the festival first to add a cover image.')).toBeInTheDocument();
		expect(screen.queryByLabelText('Cover image')).not.toBeInTheDocument();
	});

	it('downscales, presigns and uploads straight to S3, then previews the result', async () => {
		presignFestivalImage.mockResolvedValue({
			ok: true,
			data: { uploadUrl: 'https://s3.example/put', imageUrl: '/data/festival-images/tmr26-x.jpg' }
		});
		uploadToPresignedUrl.mockResolvedValue(true);
		saveFestivals.mockResolvedValue({ ok: true, data: { ok: true, festivals: SEED } });
		await renderLoaded();
		const target = SEED[0]!;

		await fireEvent.click(within(rowFor(target.name)!).getByRole('button', { name: 'Edit' }));
		await fireEvent.change(screen.getByLabelText('Cover image'), { target: { files: [imageFile()] } });

		await waitFor(() =>
			expect(screen.getByRole('img')).toHaveAttribute('src', '/data/festival-images/tmr26-x.jpg')
		);
		expect(downscaleImage).toHaveBeenCalledWith(expect.any(File));
		expect(presignFestivalImage).toHaveBeenCalledWith('tok', target.id, 'image/jpeg', expect.any(Number));
		expect(uploadToPresignedUrl).toHaveBeenCalledWith('https://s3.example/put', expect.any(File));

		// Still a draft — nothing persisted until Save.
		expect(saveFestivals).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		const [, sent] = saveFestivals.mock.calls[0] as [string, FestivalRecord[]];
		expect(sent.find((f) => f.id === target.id)?.imageUrl).toBe('/data/festival-images/tmr26-x.jpg');
	});

	it('shows an error when presigning is refused', async () => {
		presignFestivalImage.mockResolvedValue({ ok: false, unauthorized: false, status: 400 });
		await renderLoaded();
		const target = SEED[0]!;

		await fireEvent.click(within(rowFor(target.name)!).getByRole('button', { name: 'Edit' }));
		await fireEvent.change(screen.getByLabelText('Cover image'), { target: { files: [imageFile()] } });

		await waitFor(() =>
			expect(screen.getByText('Could not start the upload. Please try again.')).toBeInTheDocument()
		);
		expect(uploadToPresignedUrl).not.toHaveBeenCalled();
	});

	it('shows an error when the S3 PUT itself fails', async () => {
		presignFestivalImage.mockResolvedValue({
			ok: true,
			data: { uploadUrl: 'https://s3.example/put', imageUrl: '/data/festival-images/tmr26-x.jpg' }
		});
		uploadToPresignedUrl.mockResolvedValue(false);
		await renderLoaded();
		const target = SEED[0]!;

		await fireEvent.click(within(rowFor(target.name)!).getByRole('button', { name: 'Edit' }));
		await fireEvent.change(screen.getByLabelText('Cover image'), { target: { files: [imageFile()] } });

		await waitFor(() =>
			expect(screen.getByText('Upload failed. Please try again.')).toBeInTheDocument()
		);
	});
});

describe('admin festivals page — timetable import', () => {
	function jsonFile(content: unknown, name = 'timetable.json') {
		return new File([JSON.stringify(content)], name, { type: 'application/json' });
	}

	const VALID_TMR26_FILE = {
		formatVersion: 1,
		festivalId: 'tmr26',
		days: [
			{
				date: '2026-07-17',
				performances: [
					{ artist: 'A', stage: 'Main', startTime: '22:00', endTime: '23:00' },
					{ artist: 'B', stage: 'Second', startTime: '20:00', endTime: '21:00' }
				]
			}
		]
	};

	async function openImportFor(name: string) {
		await renderLoaded();
		await fireEvent.click(within(rowFor(name)!).getByRole('button', { name: 'Import timetable' }));
	}

	it('opens the import dialog named for the target festival', async () => {
		const target = SEED[0]!;
		await openImportFor(target.name);

		expect(screen.getByRole('dialog', { name: new RegExp(target.name) })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Confirm import' })).toBeDisabled();
	});

	it('previews a valid, matching file and enables confirm', async () => {
		await openImportFor('Tomorrowland');

		await fireEvent.change(screen.getByLabelText(/Timetable file/), {
			target: { files: [jsonFile(VALID_TMR26_FILE)] }
		});

		await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm import' })).toBeEnabled());
		expect(screen.getByText('2')).toBeInTheDocument(); // performance count
		expect(screen.getByText('Main, Second')).toBeInTheDocument();
	});

	it('rejects a file for the wrong festival', async () => {
		await openImportFor('Tomorrowland');

		await fireEvent.change(screen.getByLabelText(/Timetable file/), {
			target: { files: [jsonFile({ ...VALID_TMR26_FILE, festivalId: 'ps26' })] }
		});

		await waitFor(() =>
			expect(screen.getByText(/This file is for festivalId "ps26"/)).toBeInTheDocument()
		);
		expect(screen.getByRole('button', { name: 'Confirm import' })).toBeDisabled();
	});

	it('rejects unparsable JSON', async () => {
		await openImportFor('Tomorrowland');

		await fireEvent.change(screen.getByLabelText(/Timetable file/), {
			target: { files: [new File(['not json'], 'bad.json', { type: 'application/json' })] }
		});

		await waitFor(() =>
			expect(screen.getByText('That file is not valid JSON.')).toBeInTheDocument()
		);
	});

	it('shows validator errors for a malformed file, capped with a remainder count', async () => {
		const manyBadPerformances = Array.from({ length: 20 }, (_, i) => ({
			id: `p${i}`,
			artist: '',
			stage: '',
			startTime: 'bad',
			endTime: 'bad'
		}));
		await openImportFor('Tomorrowland');

		await fireEvent.change(screen.getByLabelText(/Timetable file/), {
			target: {
				files: [
					jsonFile({
						formatVersion: 1,
						festivalId: 'tmr26',
						days: [{ date: '2026-07-17', performances: manyBadPerformances }]
					})
				]
			}
		});

		await waitFor(() => expect(screen.getByText(/…and \d+ more\./)).toBeInTheDocument());
		expect(screen.getByRole('button', { name: 'Confirm import' })).toBeDisabled();
	});

	it('imports on confirm and closes the dialog', async () => {
		importFestivalTimetable.mockResolvedValue({ ok: true, data: { ok: true } });
		await openImportFor('Tomorrowland');
		await fireEvent.change(screen.getByLabelText(/Timetable file/), {
			target: { files: [jsonFile(VALID_TMR26_FILE)] }
		});
		await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm import' })).toBeEnabled());

		await fireEvent.click(screen.getByRole('button', { name: 'Confirm import' }));

		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
		expect(importFestivalTimetable).toHaveBeenCalledWith('tok', 'tmr26', VALID_TMR26_FILE);
	});

	it('shows a specific message when a timetable already exists', async () => {
		importFestivalTimetable.mockResolvedValue({ ok: false, unauthorized: false, status: 409 });
		await openImportFor('Tomorrowland');
		await fireEvent.change(screen.getByLabelText(/Timetable file/), {
			target: { files: [jsonFile(VALID_TMR26_FILE)] }
		});
		await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm import' })).toBeEnabled());

		await fireEvent.click(screen.getByRole('button', { name: 'Confirm import' }));

		await waitFor(() =>
			expect(
				screen.getByText('A timetable already exists for this festival — import only runs once.')
			).toBeInTheDocument()
		);
		expect(screen.getByRole('dialog')).toBeInTheDocument();
	});

	it('shows a generic error for any other failure and keeps the dialog open', async () => {
		importFestivalTimetable.mockResolvedValue({ ok: false, unauthorized: false, status: 500 });
		await openImportFor('Tomorrowland');
		await fireEvent.change(screen.getByLabelText(/Timetable file/), {
			target: { files: [jsonFile(VALID_TMR26_FILE)] }
		});
		await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm import' })).toBeEnabled());

		await fireEvent.click(screen.getByRole('button', { name: 'Confirm import' }));

		await waitFor(() =>
			expect(screen.getByText('Could not import the timetable. Please try again.')).toBeInTheDocument()
		);
	});

	it('does nothing on cancel', async () => {
		await openImportFor('Tomorrowland');

		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		expect(importFestivalTimetable).not.toHaveBeenCalled();
	});
});
