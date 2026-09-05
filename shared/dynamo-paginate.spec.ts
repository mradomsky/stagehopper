import { describe, expect, it, vi } from 'vitest';
import { collect, paginate, type PagedResult, type PagedSender } from './dynamo-paginate.js';

/** A client that answers with scripted pages and records the cursor it was asked for. */
function fakeClient(pages: PagedResult[]) {
	const cursors: (Record<string, unknown> | undefined)[] = [];
	const send = vi.fn(async (command: { start?: Record<string, unknown> }) => {
		cursors.push(command.start);
		return pages.shift() ?? { Items: [] };
	});
	return { client: { send } satisfies PagedSender, cursors, send };
}

const makeCommand = (start: Record<string, unknown> | undefined) => ({ start });

describe('paginate', () => {
	it('follows the cursor to the end and yields every item', async () => {
		const { client, cursors } = fakeClient([
			{ Items: [{ id: 1 }, { id: 2 }], LastEvaluatedKey: { k: 'a' } },
			{ Items: [{ id: 3 }], LastEvaluatedKey: { k: 'b' } },
			{ Items: [{ id: 4 }] }
		]);

		const items = await collect(paginate<{ id: number }>(client, makeCommand));

		expect(items.map((i) => i.id)).toEqual([1, 2, 3, 4]);
		// The first page asks for no cursor; each later page asks for the previous key.
		expect(cursors).toEqual([undefined, { k: 'a' }, { k: 'b' }]);
	});

	it('stops requesting pages when the caller breaks out', async () => {
		const { client, send } = fakeClient([
			{ Items: [{ id: 1 }], LastEvaluatedKey: { k: 'a' } },
			{ Items: [{ id: 2 }], LastEvaluatedKey: { k: 'b' } }
		]);

		for await (const _item of paginate(client, makeCommand)) break;

		// The whole point of the generator: an early exit never asks for page two.
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('treats a missing Items array as an empty page', async () => {
		const { client } = fakeClient([{ LastEvaluatedKey: { k: 'a' } }, {}]);
		expect(await collect(paginate(client, makeCommand))).toEqual([]);
	});

	it('makes no request beyond the first when there is no cursor', async () => {
		const { client, send } = fakeClient([{ Items: [{ id: 1 }] }]);
		expect(await collect(paginate(client, makeCommand))).toHaveLength(1);
		expect(send).toHaveBeenCalledTimes(1);
	});
});
