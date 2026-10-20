/**
 * @file Operator entry point for the Room Picks migration (#206). Runbook: docs/festival-picks-infra.md.
 *
 * Not part of either Lambda bundle: build it on its own (command in the runbook) and run it
 * from an operator machine with AWS credentials and the Clerk production secret key.
 *
 *   node migrate-picks.mjs --dry-run   # reads everything, writes nothing
 *   node migrate-picks.mjs             # the real run
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { clerkUsersFetcher, migratePicks } from './migrate-picks.js';

const REQUIRED_ENV = [
	'AWS_REGION',
	'TABLE_NAME',
	'USERS_TABLE',
	'ROOMS_TABLE',
	'FESTIVALS_TABLE',
	'PERFORMANCES_TABLE',
	'PICKS_TABLE',
	'CLERK_SECRET_KEY'
] as const;

const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missing.length > 0) {
	console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
	process.exit(1);
}
const env = process.env as Record<(typeof REQUIRED_ENV)[number], string>;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.AWS_REGION }));
const dryRun = process.argv.includes('--dry-run');

console.log(dryRun ? 'DRY RUN: nothing will be written' : 'REAL RUN: writing users and Picks rows');
try {
	await migratePicks({
		send: (command) => ddb.send(command),
		fetchClerkUsers: clerkUsersFetcher(env.CLERK_SECRET_KEY),
		tables: {
			selections: env.TABLE_NAME,
			users: env.USERS_TABLE,
			rooms: env.ROOMS_TABLE,
			festivals: env.FESTIVALS_TABLE,
			performances: env.PERFORMANCES_TABLE,
			picks: env.PICKS_TABLE
		},
		dryRun
	});
} catch (err) {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
}
