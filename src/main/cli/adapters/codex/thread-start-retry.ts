/**
 * thread/start retry with backoff.
 *
 * Under host overload (2026-07-01 incident: 15-min loadavg ~290) a healthy
 * `codex app-server` can miss the control-RPC deadline for `thread/start`.
 * Previously that single timeout terminally failed interrupt-respawn
 * ("Failed to respawn stuck process") and surfaced "Couldn't resume this
 * session". A short backoff-retry turns that into a delay instead.
 *
 * Only RPC *timeouts* are retried: a closed client/connection cannot recover
 * by re-asking the same client, and server-side rejections (e.g. "no rollout
 * found") are deterministic. Kept free of runtime imports from
 * app-server-client so the adapter's lazy `import()` of that module is not
 * defeated.
 */

import { getLogger } from '../../../logging/logger';
import type { AppServerRequestParams, AppServerResponseResult } from './app-server-types';

const logger = getLogger('CodexThreadStartRetry');

type ThreadStartParams = AppServerRequestParams<'thread/start'>;
type ThreadStartResult = AppServerResponseResult<'thread/start'>;

/** Minimal structural view of an app-server client for thread/start. */
export interface ThreadStartClient {
  request(method: 'thread/start', params: ThreadStartParams): Promise<ThreadStartResult>;
}

export interface StartThreadWithRetryOptions {
  /** Total attempts including the first (default 3). */
  maxAttempts?: number;
  /** Backoff before attempt N+1; last entry repeats (default [5s, 15s]). */
  retryDelaysMs?: readonly number[];
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000];

/**
 * True for errors where retrying the SAME client can plausibly succeed —
 * i.e. per-RPC timeouts (starved host, busy server). Name-based check so this
 * module does not need a runtime import of ProtocolError.
 */
export function isTransientThreadStartError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'ProtocolError' &&
    /RPC timeout/i.test(error.message)
  );
}

export async function startThreadWithRetry(
  client: ThreadStartClient,
  params: ThreadStartParams,
  options: StartThreadWithRetryOptions = {},
): Promise<ThreadStartResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await client.request('thread/start', params);
    } catch (error) {
      lastError = error;
      if (!isTransientThreadStartError(error) || attempt === maxAttempts) {
        throw error;
      }
      const delayMs = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] ?? 5_000;
      logger.warn('thread/start timed out — retrying with backoff (host may be overloaded)', {
        attempt,
        maxAttempts,
        delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(delayMs);
    }
  }

  // Unreachable: the loop either returns or throws on the last attempt.
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
