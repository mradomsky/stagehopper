/**
 * @file Reads secret values from SSM Parameter Store at runtime.
 *
 * A secret passed as a Lambda environment variable ends up in Terraform state:
 * every refresh records the live environment, so the value sits in plaintext in
 * the state object and in each retained version of it. `ignore_changes`
 * suppresses the diff, not the read.
 *
 * So the environment carries the parameter *name* and the value is fetched here
 * on first use. Values that are public by design — the VAPID public key and
 * subject — stay plain environment variables; only real credentials belong here.
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});

/**
 * Cached per parameter name for the life of the execution environment, so a warm
 * container does not call SSM again. Promises rather than values: concurrent
 * callers during a cold start then share a single request.
 */
const cache = new Map<string, Promise<string>>();

/**
 * Resolve a `SecureString` parameter to its decrypted value.
 *
 * @throws if the parameter is missing, empty, or unreadable. Callers should let
 * that surface — a notifier run that silently continues without its signing key
 * looks healthy while delivering nothing.
 */
export function getSecret(parameterName: string): Promise<string> {
	const cached = cache.get(parameterName);
	if (cached) return cached;

	const pending = ssm
		.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }))
		.then((result) => {
			const value = result.Parameter?.Value;
			if (!value) {
				throw new Error(`SSM parameter ${parameterName} is empty`);
			}
			return value;
		})
		.catch((err) => {
			// Drop the rejected promise: caching it would poison the container for the
			// rest of its life over what may be a transient SSM error.
			cache.delete(parameterName);
			throw err;
		});

	cache.set(parameterName, pending);
	return pending;
}
