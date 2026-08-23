import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';

import type { FestivalRecord } from '$lib/stagehopper/types.js';

const fetchAdminFestivals = vi.fn();
const createFestival = vi.fn();
const updateFestival = vi.fn();
const deleteFestival = vi.fn();
const presignFestivalImage = vi.fn();
const uploadToPresignedUrl = vi.fn();
const importFestivalTimetable = vi.fn();
const downscaleImage = vi.fn();
const fetchMock = vi.fn();

vi.mock('$lib/stagehopper/api.js', () => ({
	fetchAdminFestivals: (...args: unknown[]) => fetchAdminFestivals(...args),
	createFestival: (...args: unknown[]) => createFestival(...args),
	updateFestival: (...args: unknown[]) => updateFestival(...args),
	deleteFestival: (...args: unknown[]) => deleteFestival(...args),
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
		endDate: '2026-07-20'
	},
	{
		id: 'ps26',
		name: 'Primavera Sound Barcelona 2026',
		location: 'Barcelona',
		startDate: '2026-06-04',
		endDate: '2026-06-06'
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
	fetchMock.mockReset().mockResolvedValue(jsonResponse(SEED));
	vi.stubGlobal('fetch', fetchMock);
	fetchAdminFestivals.mockReset().mockResolvedValue({ ok: true, data: { festivals: SEED } });
	createFestival.mockReset();
	updateFestival.mockReset();
	deleteFestival.mockReset();
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
	// The editor reads through the API rather than off CloudFront: the public copy is cached
	// by design, and an editor rendering an edge copy races the write it just made.
	it('reads the list through the admin endpoint, not the cached public path', async () => {
		await renderLoaded();

		expect(fetchAdminFestivals).toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalledWith('/data/festivals/index.json', expect.anything());
	});

	it('lists every fetched festival', async () => {
		await renderLoaded();

		for (const festival of SEED) {
			expect(screen.getByText(new RegExp(festival.name))).toBeInTheDocument();
		}
	});

	it('falls back to the compiled defaults when the read fails', async () => {
		fetchAdminFestivals.mockResolvedValue({ ok: false, unauthorized: false, status: 500 });

		await renderLoaded();

		expect(screen.getByText(/Tomorrowland/)).toBeInTheDocument();
		expect(screen.getByText(/Could not load the festival list/)).toBeInTheDocument();
	});

	// Nothing published yet: the S3 object only exists after the first save, so the compiled
	// defaults are what visitors are actually being served.
	it('shows the compiled defaults, without an error, when nothing is published', async () => {
		fetchAdminFestivals.mockResolvedValue({ ok: true, data: { festivals: [] } });

		await renderLoaded();

		expect(screen.getByText(/Tomorrowland/)).toBeInTheDocument();
		expect(screen.queryByText(/Could not load the festival list/)).not.toBeInTheDocument();
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
	it('saves a new festival with the admin-set id and shows it once the write succeeds', async () => {
		createFestival.mockResolvedValue({
			ok: true,
			data: { ok: true, festival: { id: 'testfest', name: 'Test Fest 2027' } }
		});
		await renderLoaded();

		await fireEvent.click(screen.getByRole('button', { name: 'New festival' }));

		await fireEvent.input(screen.getByLabelText('Id'), { target: { value: 'testfest' } });
		await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Test Fest 2027' } });
		await fireEvent.input(screen.getByLabelText('Location'), { target: { value: 'Testville' } });
		await fireEvent.input(screen.getByLabelText('Start date'), {
			target: { value: '2027-01-01' }
		});
		await fireEvent.input(screen.getByLabelText('End date'), { target: { value: '2027-01-03' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
		expect(screen.getByText(/Test Fest 2027/)).toBeInTheDocument();

		const [sentFestival] = createFestival.mock.calls[0] as [FestivalRecord];
		expect(sentFestival.id).toBe('testfest');
		expect(updateFestival).not.toHaveBeenCalled();
	});

	it('rejects an invalid or duplicate id', async () => {
		await renderLoaded();

		await fireEvent.click(screen.getByRole('button', { name: 'New festival' }));
		await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Test Fest' } });
		await fireEvent.input(screen.getByLabelText('Location'), { target: { value: 'Testville' } });
		await fireEvent.input(screen.getByLabelText('Start date'), { target: { value: '2027-01-01' } });
		await fireEvent.input(screen.getByLabelText('End date'), { target: { value: '2027-01-03' } });

		// Uppercase/symbols are rejected by format.
		await fireEvent.input(screen.getByLabelText('Id'), { target: { value: 'Bad Id!' } });
		expect(screen.getByText('2–10 lowercase letters or digits.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

		// A valid but already-taken id is rejected too.
		await fireEvent.input(screen.getByLabelText('Id'), { target: { value: 'tmr26' } });
		expect(screen.getByText('That id is already taken.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

		// A valid, free id clears the error and enables Save.
		await fireEvent.input(screen.getByLabelText('Id'), { target: { value: 'tf27' } });
		expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
	});

	it('will not save a festival missing required fields', async () => {
		await renderLoaded();

		await fireEvent.click(screen.getByRole('button', { name: 'New festival' }));

		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
	});

	it('will not save when the end date is before the start date', async () => {
		await renderLoaded();

		await fireEvent.click(screen.getByRole('button', { name: 'New festival' }));
		await fireEvent.input(screen.getByLabelText('Id'), { target: { value: 'bad27' } });
		await fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Bad Dates' } });
		await fireEvent.input(screen.getByLabelText('Location'), { target: { value: 'Nowhere' } });
		await fireEvent.input(screen.getByLabelText('Start date'), {
			target: { value: '2027-01-10' }
		});
		await fireEvent.input(screen.getByLabelText('End date'), { target: { value: '2027-01-01' } });

		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
	});

	it('shows an error and keeps the form open when the save fails', async () => {
		createFestival.mockResolvedValue({ ok: false, unauthorized: false, status: 500 });
		await renderLoaded();

		await fireEvent.click(screen.getByRole('button', { name: 'New festival' }));
		await fireEvent.input(screen.getByLabelText('Id'), { target: { value: 'tf27' } });
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
		updateFestival.mockResolvedValue({ ok: true, data: { ok: true, festival: updated } });
		await renderLoaded();

		await fireEvent.click(within(rowFor(target.name)!).getByRole('button', { name: 'Edit' }));
		await fireEvent.input(screen.getByLabelText('Location'), {
			target: { value: 'Updated location' }
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => expect(screen.getByText('Updated location')).toBeInTheDocument());
		const [sentFestival] = updateFestival.mock.calls[0] as [FestivalRecord];
		expect(sentFestival.id).toBe(target.id);
		expect(createFestival).not.toHaveBeenCalled();
	});
});

describe('admin festivals page — delete', () => {
	it('deletes a festival after confirming', async () => {
		deleteFestival.mockResolvedValue({ ok: true, data: { ok: true } });
		await renderLoaded();
		const target = SEED[0]!;

		await fireEvent.click(within(rowFor(target.name)!).getByRole('button', { name: 'Delete' }));
		const dialog = screen.getByRole('dialog', { name: 'Delete festival?' });

		await fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

		await waitFor(() => expect(screen.queryByText(new RegExp(target.name))).not.toBeInTheDocument());
		expect(deleteFestival).toHaveBeenCalledWith(target.id);
	});

	it('keeps the festival on cancel', async () => {
		await renderLoaded();
		const target = SEED[0]!;

		await fireEvent.click(within(rowFor(target.name)!).getByRole('button', { name: 'Delete' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.getByText(new RegExp(target.name))).toBeInTheDocument();
		expect(deleteFestival).not.toHaveBeenCalled();
	});
});

describe('admin festivals page — cover image', () => {
	function imageFile() {
		return new File(['bytes'], 'cover.jpg', { type: 'image/jpeg' });
	}

	it('gates cover-image upload on a valid id while creating', async () => {
		await renderLoaded();

		await fireEvent.click(screen.getByRole('button', { name: 'New festival' }));

		// No id yet: the upload is disabled with a hint.
		expect(screen.getByText('Enter a valid id above to upload a cover image.')).toBeInTheDocument();
		expect(screen.getByLabelText('Cover image')).toBeDisabled();

		// A valid id unlocks it.
		await fireEvent.input(screen.getByLabelText('Id'), { target: { value: 'new27' } });
		expect(screen.getByLabelText('Cover image')).toBeEnabled();
	});

	it('uploads a cover image during creation with the admin-set id', async () => {
		presignFestivalImage.mockResolvedValue({
			ok: true,
			data: { uploadUrl: 'https://s3.example/put', imageUrl: '/data/festival-images/new27-x.jpg' }
		});
		uploadToPresignedUrl.mockResolvedValue(true);
		await renderLoaded();

		await fireEvent.click(screen.getByRole('button', { name: 'New festival' }));
		await fireEvent.input(screen.getByLabelText('Id'), { target: { value: 'new27' } });
		await fireEvent.change(screen.getByLabelText('Cover image'), { target: { files: [imageFile()] } });

		await waitFor(() =>
			expect(screen.getByRole('img')).toHaveAttribute('src', '/data/festival-images/new27-x.jpg')
		);
		expect(presignFestivalImage).toHaveBeenCalledWith('new27', 'image/jpeg', expect.any(Number));
	});

	it('downscales, presigns and uploads straight to S3, then previews the result', async () => {
		presignFestivalImage.mockResolvedValue({
			ok: true,
			data: { uploadUrl: 'https://s3.example/put', imageUrl: '/data/festival-images/tmr26-x.jpg' }
		});
		uploadToPresignedUrl.mockResolvedValue(true);
		updateFestival.mockResolvedValue({ ok: true, data: { ok: true, festival: SEED[0]! } });
		await renderLoaded();
		const target = SEED[0]!;

		await fireEvent.click(within(rowFor(target.name)!).getByRole('button', { name: 'Edit' }));
		await fireEvent.change(screen.getByLabelText('Cover image'), { target: { files: [imageFile()] } });

		await waitFor(() =>
			expect(screen.getByRole('img')).toHaveAttribute('src', '/data/festival-images/tmr26-x.jpg')
		);
		expect(downscaleImage).toHaveBeenCalledWith(expect.any(File));
		expect(presignFestivalImage).toHaveBeenCalledWith(target.id, 'image/jpeg', expect.any(Number));
		expect(uploadToPresignedUrl).toHaveBeenCalledWith('https://s3.example/put', expect.any(File));

		// Still a draft — nothing persisted until Save.
		expect(updateFestival).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		const [sent] = updateFestival.mock.calls[0] as [FestivalRecord];
		expect(sent.imageUrl).toBe('/data/festival-images/tmr26-x.jpg');
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
		expect(importFestivalTimetable).toHaveBeenCalledWith('tmr26', VALID_TMR26_FILE);
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
