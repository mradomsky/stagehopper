/**
 * @file StageHopper festivals configuration.
 */

export const FESTIVALS = [
	{
		id: 'tmr26',
		prefix: 'tmr26-',
		name: 'Tomorrowland 2026 – Week 1',
		subtitle: 'Boom, Belgium · July 17–20',
		past: false,
		accent: 'linear-gradient(135deg, #ff9a56, #ff6b6b 55%, #c44569)',
		emoji: '🎪'
	},
	{
		id: 'ps26',
		prefix: 'ps26-',
		name: 'Primavera Sound Barcelona 2026',
		subtitle: 'Barcelona · June 4–6',
		past: true,
		accent: 'linear-gradient(135deg, #4facfe, #6c5ce7)',
		emoji: '🌊'
	}
];

/**
 * Find festival by room ID prefix.
 * @param {string} roomId
 * @returns {typeof FESTIVALS[0] | null}
 */
export function getFestivalByPrefix(roomId) {
	return FESTIVALS.find((f) => roomId.startsWith(f.prefix)) ?? null;
}

/**
 * Find festival by exact id — used for guest browse routes, which are bare festival ids.
 * @param {string} id
 * @returns {typeof FESTIVALS[0] | null}
 */
export function getFestivalById(id) {
	return FESTIVALS.find((f) => f.id === id) ?? null;
}
