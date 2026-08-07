import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { resetMockPage, setMockPage } from '../test-support/app-state.svelte.js';
import { saveGoogleAuth } from '$lib/stagehopper/storage.js';

const patchFestivalTimetable = vi.fn();
const fetchMock = vi.fn();

vi.mock('$app/state', async () => {
	const { mockPage } = await import('../test-support/app-state.svelte.js');
	return { page: mockPage };
});

vi.mock('$lib/stagehopper/api.js', () => ({
	patchFestivalTimetable: (...args: unknown[]) => patchFestivalTimetable(...args)
}));

const { default: AdminTimetableEditorPage } = await import('./admin/festivals/[id]/timetable/+page.svelte');

const STORED_TIMETABLE = {
	formatVersion: 1,
	festivalId: 'tmr26',
	days: [
		{
			date: '2026-07-17',
			performances: [
				{ id: 'p1', artist: 'Test Artist', stage: 'Main', startTime: '22:00', endTime: '23:00' }
			]
		},
		{
			date: '2026-07-18',
			performances: [
				{ id: 'p2', artist: 'Second Day Artist', stage: 'Main', startTime: '20:00', endTime: '21:00' }
			]
		}
	]
};

function jsonResponse(body: unknown, status = 200) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function signIn() {
	saveGoogleAuth({ idToken: 'tok', sub: '1', name: 'Admin', givenName: 'Admin' });
}

async function renderLoaded(timetable: unknown = STORED_TIMETABLE) {
	fetchMock.mockResolvedValue(jsonResponse(timetable));
	setMockPage({ params: { id: 'tmr26' } });
	const result = render(AdminTimetableEditorPage);
	await screen.findByText('Test Artist');
	return result;
}

beforeEach(() => {
	signIn();
	fetchMock.mockReset();
	patchFestivalTimetable.mockReset();
	vi.stubGlobal('fetch', fetchMock);
	vi.spyOn(Math, 'random').mockReturnValue(0);
	resetMockPage();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	localStorage.clear();
});

describe('admin timetable editor — loading', () => {
	it('fetches the named festival directly, with no room resolution', async () => {
		await renderLoaded();

		expect(fetchMock).toHaveBeenCalledWith('/data/timetable-tmr26.json');
	});

	it('shows a load error when the fetch fails', async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, 404));
		setMockPage({ params: { id: 'tmr26' } });

		render(AdminTimetableEditorPage);

		expect(await screen.findByText('Could not load the timetable.')).toBeInTheDocument();
	});

	it('shows day tabs and the first day by default', async () => {
		await renderLoaded();

		expect(screen.getByRole('button', { name: 'Friday, July 17' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Saturday, July 18' })).toBeInTheDocument();
		expect(screen.queryByText('Second Day Artist')).not.toBeInTheDocument();
	});

	it('switches days on tab click', async () => {
		await renderLoaded();

		await fireEvent.click(screen.getByRole('button', { name: 'Saturday, July 18' }));

		expect(screen.getByText('Second Day Artist')).toBeInTheDocument();
		expect(screen.queryByText('Test Artist')).not.toBeInTheDocument();
	});
});

describe('admin timetable editor — editing', () => {
	it('opens the edit form pre-filled from the tapped performance', async () => {
		await renderLoaded();

		await fireEvent.click(screen.getByText('Test Artist'));

		expect(screen.getByRole('dialog', { name: 'Edit performance' })).toBeInTheDocument();
		expect(screen.getByLabelText('Artist')).toHaveValue('Test Artist');
		expect(screen.getByLabelText('Stage')).toHaveValue('Main');
		expect(screen.getByLabelText('Start time')).toHaveValue('22:00');
		expect(screen.queryByLabelText('Day')).not.toBeInTheDocument();
	});

	it('saves an edit as a patch keyed to the existing id, and re-renders the result', async () => {
		patchFestivalTimetable.mockResolvedValue({
			ok: true,
			data: {
				ok: true,
				timetable: {
					...STORED_TIMETABLE,
					days: [
						{
							...STORED_TIMETABLE.days[0],
							performances: [{ ...STORED_TIMETABLE.days[0]!.performances[0], artist: 'Renamed Artist' }]
						},
						STORED_TIMETABLE.days[1]
					]
				}
			}
		});
		await renderLoaded();
		await fireEvent.click(screen.getByText('Test Artist'));

		await fireEvent.input(screen.getByLabelText('Artist'), { target: { value: 'Renamed Artist' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(patchFestivalTimetable).toHaveBeenCalledWith('tok', 'tmr26', 'p1', {
			artist: 'Renamed Artist',
			stage: 'Main',
			startTime: '22:00',
			endTime: '23:00',
			artistImage: '',
			instagram: ''
		});
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
		expect(screen.getByText('Renamed Artist')).toBeInTheDocument();
	});

	it('shows a save error and keeps the dialog open on failure', async () => {
		patchFestivalTimetable.mockResolvedValue({ ok: false, unauthorized: false, status: 500 });
		await renderLoaded();
		await fireEvent.click(screen.getByText('Test Artist'));

		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(await screen.findByText('Could not save. Please try again.')).toBeInTheDocument();
		expect(screen.getByRole('dialog')).toBeInTheDocument();
	});

	it('reloads the timetable on a 412 conflict', async () => {
		patchFestivalTimetable.mockResolvedValue({ ok: false, unauthorized: false, status: 412 });
		await renderLoaded();
		await fireEvent.click(screen.getByText('Test Artist'));
		fetchMock.mockClear();

		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/data/timetable-tmr26.json'));
	});

	it('disables Save until the required fields are filled', async () => {
		await renderLoaded();
		await fireEvent.click(screen.getByText('Test Artist'));
		await fireEvent.input(screen.getByLabelText('Artist'), { target: { value: '' } });

		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
	});

	it('cancels without saving', async () => {
		await renderLoaded();
		await fireEvent.click(screen.getByText('Test Artist'));

		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		expect(patchFestivalTimetable).not.toHaveBeenCalled();
	});
});

describe('admin timetable editor — delete', () => {
	it('deletes via a null patch after confirming', async () => {
		patchFestivalTimetable.mockResolvedValue({
			ok: true,
			data: { ok: true, timetable: { ...STORED_TIMETABLE, days: [{ ...STORED_TIMETABLE.days[0], performances: [] }, STORED_TIMETABLE.days[1]] } }
		});
		await renderLoaded();
		await fireEvent.click(screen.getByText('Test Artist'));

		await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		expect(screen.getByRole('dialog', { name: 'Delete performance?' })).toBeInTheDocument();

		await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

		expect(patchFestivalTimetable).toHaveBeenCalledWith('tok', 'tmr26', 'p1', null);
		await waitFor(() => expect(screen.queryByText('Test Artist')).not.toBeInTheDocument());
	});
});

describe('admin timetable editor — add', () => {
	it('opens a blank form with a day selector and a generated id', async () => {
		await renderLoaded();

		await fireEvent.click(screen.getByRole('button', { name: 'Add performance' }));

		expect(screen.getByRole('dialog', { name: 'Add performance' })).toBeInTheDocument();
		expect(screen.getByLabelText('Artist')).toHaveValue('');
		expect(screen.getByLabelText('Day')).toBeInTheDocument();
	});

	it('adds a new performance placed under the selected day', async () => {
		patchFestivalTimetable.mockResolvedValue({
			ok: true,
			data: {
				ok: true,
				timetable: {
					...STORED_TIMETABLE,
					days: [
						{
							...STORED_TIMETABLE.days[0],
							performances: [
								...STORED_TIMETABLE.days[0]!.performances,
								{
									id: '000000',
									artist: 'New Artist',
									stage: 'Second',
									startTime: '18:00',
									endTime: '19:00'
								}
							]
						},
						STORED_TIMETABLE.days[1]
					]
				}
			}
		});
		await renderLoaded();
		await fireEvent.click(screen.getByRole('button', { name: 'Add performance' }));

		await fireEvent.input(screen.getByLabelText('Artist'), { target: { value: 'New Artist' } });
		await fireEvent.input(screen.getByLabelText('Stage'), { target: { value: 'Second' } });
		await fireEvent.input(screen.getByLabelText('Start time'), { target: { value: '18:00' } });
		await fireEvent.input(screen.getByLabelText('End time'), { target: { value: '19:00' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(patchFestivalTimetable).toHaveBeenCalledWith('tok', 'tmr26', '000000', {
			date: '2026-07-17',
			artist: 'New Artist',
			stage: 'Second',
			startTime: '18:00',
			endTime: '19:00',
			artistImage: '',
			instagram: ''
		});
		await waitFor(() => expect(screen.getByText('New Artist')).toBeInTheDocument());
	});

	it('has no delete button for a new, unsaved performance', async () => {
		await renderLoaded();

		await fireEvent.click(screen.getByRole('button', { name: 'Add performance' }));

		expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
	});
});
