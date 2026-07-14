/**
 * @file StageHopper festivals configuration.
 */

export const FESTIVALS = [
	{
		id: 'tmr26',
		prefix: 'tmr26-',
		name: 'Tomorrowland 2026 – Week 1',
		subtitle: 'Boom, Belgium · July 17–20',
		past: false
	},
	{
		id: 'ps26',
		prefix: 'ps26-',
		name: 'Primavera Sound Barcelona 2026',
		subtitle: 'Barcelona · June 4–6',
		past: true
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
