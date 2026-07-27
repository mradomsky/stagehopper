/**
 * @file In-memory data for the admin screens, until the real endpoints land.
 *
 * Each screen imports exactly one of these arrays, so wiring up a real endpoint later
 * (#34, #36, #38) is a one-line import swap per screen, not a rewrite.
 */

export interface AdminFestival {
	id: string;
	prefix: string;
	name: string;
	subtitle: string;
	past: boolean;
	accent: string;
	emoji: string;
	/** Placeholder for the upload landing in #35; a URL until then. */
	cardImageUrl: string;
}

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

export const FIXTURE_FESTIVALS: AdminFestival[] = [
	{
		id: 'tmr26',
		prefix: 'tmr26-',
		name: 'Tomorrowland 2026 – Week 1',
		subtitle: 'Boom, Belgium · July 17–20',
		past: false,
		accent: 'linear-gradient(135deg, #ff9a56, #ff6b6b 55%, #c44569)',
		emoji: '🎪',
		cardImageUrl: ''
	},
	{
		id: 'ps26',
		prefix: 'ps26-',
		name: 'Primavera Sound Barcelona 2026',
		subtitle: 'Barcelona · June 4–6',
		past: true,
		accent: 'linear-gradient(135deg, #4facfe, #6c5ce7)',
		emoji: '🌊',
		cardImageUrl: ''
	}
];

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
