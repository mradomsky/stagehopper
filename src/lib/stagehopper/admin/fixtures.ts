/**
 * @file In-memory data for the admin screens whose real endpoints don't exist yet.
 *
 * Festivals moved to real data in #34 (`festivals.svelte.ts`). Rooms and users still
 * import from here until #38; each is a one-line import swap when that lands.
 */

export interface AdminRoom {
	roomId: string;
	festivalName: string;
	participantCount: number;
	updatedAt: number;
}

export interface AdminUser {
	userId: string;
	name: string;
	email: string;
	roomCount: number;
	lastActive: number;
}

export const FIXTURE_ROOMS: AdminRoom[] = [
	{
		roomId: 'tmr26-a1b2c3',
		festivalName: 'Tomorrowland 2026 – Week 1',
		participantCount: 4,
		updatedAt: Date.parse('2026-07-20T18:30:00Z')
	},
	{
		roomId: 'tmr26-d4e5f6',
		festivalName: 'Tomorrowland 2026 – Week 1',
		participantCount: 2,
		updatedAt: Date.parse('2026-07-19T09:15:00Z')
	},
	{
		roomId: 'ps26-7a8b9c',
		festivalName: 'Primavera Sound Barcelona 2026',
		participantCount: 7,
		updatedAt: Date.parse('2026-06-05T21:00:00Z')
	},
	{
		roomId: 'our-crew',
		festivalName: 'Primavera Sound Barcelona 2026',
		participantCount: 3,
		updatedAt: Date.parse('2026-06-01T12:00:00Z')
	}
];

export const FIXTURE_USERS: AdminUser[] = [
	{
		userId: 'google:100000000000000000001',
		name: 'Alex Example',
		email: 'alex@example.com',
		roomCount: 3,
		lastActive: Date.parse('2026-07-20T18:30:00Z')
	},
	{
		userId: 'google:100000000000000000002',
		name: 'Sam Rivera',
		email: 'sam@example.com',
		roomCount: 1,
		lastActive: Date.parse('2026-07-19T09:15:00Z')
	},
	{
		userId: 'google:100000000000000000003',
		name: 'Jo Chen',
		email: 'jo@example.com',
		roomCount: 2,
		lastActive: Date.parse('2026-06-05T21:00:00Z')
	}
];
