/**
 * thread/resume retry with backoff.
 *
 * Symmetric to {@link startThreadWithRetry}. Under host overload (2026-07-01
 * incident: 15-min loadavg ~290) a healthy `codex app-server` can miss the
 * control-RPC deadline for `thread/resume`. Previously a single such timeout
 * on the persisted-cursor resume was NOT classified as a recoverable
 * "no rollout found" error, so it threw and terminally failed the spawn — or,
 * where the caller swallowed it, dropped straight to a full transcript replay.
 * Either way a large-context session lost native resume over a transient blip.
 * A short backoff-retry turns that into a delay instead.
 *
 * Only RPC *timeouts* are retried: a closed client/connection cannot recover by
 * re-asking the same client, and server-side rejections (e.g. "no rollout
 * found") are deterministic and must fall through to the caller's recoverable
 * handling unchanged. Kept free of runtime imports from app-server-client so the
 * adapter's lazy `import()` of that module is not defeated.
 */

import { getLogger } from '../../../logging/logger';
import { isTransientRpcTimeoutError } from './thread-start-retry';
import type { AppServerRequestParams, AppServerResponseResult } from './app-server-types';

const logger = getLogger('CodexThreadResumeRetry');

type ThreadResumeParams = AppServerRequestParams<'thread/resume'>;
type ThreadResumeResult = AppServerResponseResult<'thread/resume'>;

/** Minimal structural view of an app-server client for thread/resume. */
export interface ThreadResumeClient {
  request(method: 'thread/resume', params: ThreadResumeParams): Promise<ThreadResumeResult>;
}

export interface ResumeThreadWithRetryOptions {
  /** Total attempts including the first (default 3). */
  maxAttempts?: number;
  /** Backoff before attempt N+1; last entry repeats (default [5s, 15s]). */
  retryDelaysMs?: readonly number[];
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000];

export async function resumeThreadWithRetry(
  client: ThreadResumeClient,
  params: ThreadResumeParams,
  options: ResumeThreadWithRetryOptions = {},
): Promise<ThreadResumeResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await client.request('thread/resume', params);
    } catch (error) {
      lastError = error;
      if (!isTransientRpcTimeoutError(error) || attempt === maxAttempts) {
        throw error;
      }
      const delayMs = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] ?? 5_000;
      logger.warn('thread/resume timed out — retrying with backoff (host may be overloaded)', {
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
