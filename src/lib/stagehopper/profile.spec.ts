import { describe, expect, it } from 'vitest';
import { isProfileComplete, nicknameProblem, profileRefused } from './profile.js';

describe('isProfileComplete', () => {
	it('needs a Nickname and a Colour; null is unknown, not missing', () => {
		expect(isProfileComplete({ nickname: 'alex', colour: '#e74c3c' })).toBe(true);
		expect(isProfileComplete({ nickname: '', colour: '#e74c3c' })).toBe(false);
		expect(isProfileComplete({ nickname: 'alex', colour: null })).toBe(false);
		expect(isProfileComplete(null)).toBe(true);
	});
});

describe('profileRefused', () => {
	it('matches a 400 about nickname or colour only', () => {
		expect(profileRefused({ status: 400, error: 'nickname is required' })).toBe(true);
		expect(profileRefused({ status: 400, error: 'choose a colour first' })).toBe(true);
		expect(profileRefused({ status: 400, error: 'text too long' })).toBe(false);
		expect(profileRefused({ status: 500, error: 'nickname is required' })).toBe(false);
		expect(profileRefused({ status: 400 })).toBe(false);
	});
});

describe('nicknameProblem', () => {
	it('accepts 2 to 20 of letters, digits, _ and -, ignoring outer spaces', () => {
		expect(nicknameProblem(' alex_1 ')).toBe('');
		expect(nicknameProblem('a')).not.toBe('');
		expect(nicknameProblem('a'.repeat(21))).not.toBe('');
		expect(nicknameProblem('al ex')).not.toBe('');
	});
});
