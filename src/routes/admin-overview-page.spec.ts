import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { FIXTURE_FESTIVALS, FIXTURE_ROOMS, FIXTURE_USERS } from '$lib/stagehopper/admin/fixtures.js';

const { default: AdminOverviewPage } = await import('./admin/+page.svelte');

describe('admin overview', () => {
	it('counts each fixture set', () => {
		render(AdminOverviewPage);

		expect(screen.getByText(String(FIXTURE_FESTIVALS.length)).closest('a')).toHaveAttribute(
			'href',
			'/admin/festivals'
		);
		expect(screen.getByText(String(FIXTURE_ROOMS.length)).closest('a')).toHaveAttribute(
			'href',
			'/admin/rooms'
		);
		expect(screen.getByText(String(FIXTURE_USERS.length)).closest('a')).toHaveAttribute(
			'href',
			'/admin/users'
		);
	});
});
