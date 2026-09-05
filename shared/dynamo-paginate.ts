/**
 * @file Following a DynamoDB cursor to the end, once.
 *
 * Both Lambda bundles hand-rolled this loop, four times between them, in three different
 * shapes: two collect every item, one stops at the first hit, and one does work per page.
 * A `collectAll` helper would have absorbed two of the four and left the interesting ones —
 * the early exit and the streaming scan — still hand-rolled.
 *
 * An async generator fits all four, because it lets the *caller* decide when to stop:
 *
 * ```ts
 * const rows = await collect(paginate(ddb, (start) => new QueryCommand({ ...q, ExclusiveStartKey: start })));
 * for await (const row of paginate(...)) return true;         // early exit, pages no further
 * for await (const user of paginate(...)) await handle(user); // streams, never holds the table
 * ```
 *
 * Unlike a helper that returns an array, the early-exit caller genuinely stops paging: a
 * `break` ends the generator, so the next page is never requested.
 *
 * Structurally typed on purpose — no AWS SDK import. This file sits in `shared/`, which the
 * SPA's type-check also compiles, and the SDK is installed only under `lambda/`. The shapes
 * below are the parts of the client and the response this loop actually touches.
 */

/** The slice of a DynamoDB page this loop reads. */
export interface PagedResult {
	Items?: Record<string, unknown>[];
	LastEvaluatedKey?: Record<string, unknown>;
}

/**
 * The slice of a DocumentClient this loop calls.
 *
 * `unknown` rather than a command type: this file declares no AWS SDK import, and the
 * commands are opaque to the loop, which only hands back whatever `makeCommand` built.
 * Declared with method syntax so a real client — whose `send` takes concrete command
 * types — is still assignable.
 */
export interface PagedSender {
	send(command: unknown): Promise<PagedResult>;
}

/**
 * Yield every item of a Query or Scan, following `LastEvaluatedKey` until it is absent.
 *
 * `makeCommand` is called once per page rather than the command being passed in directly,
 * because a command carries its own `ExclusiveStartKey` and each page needs a new one.
 *
 * Items are yielded as `T` without checking: DynamoDB rows are untyped, and every existing
 * call site already asserted the row shape it expected. This preserves that, rather than
 * quietly promising a validation it does not do.
 */
export async function* paginate<T>(
	client: PagedSender,
	makeCommand: (startKey: Record<string, unknown> | undefined) => unknown
): AsyncGenerator<T> {
	let startKey: Record<string, unknown> | undefined;
	do {
		const result = await client.send(makeCommand(startKey));
		for (const item of result.Items ?? []) yield item as T;
		startKey = result.LastEvaluatedKey;
	} while (startKey);
}

/** Drain a {@link paginate} generator into an array, for callers that want every row. */
export async function collect<T>(items: AsyncGenerator<T>): Promise<T[]> {
	const all: T[] = [];
	for await (const item of items) all.push(item);
	return all;
}
