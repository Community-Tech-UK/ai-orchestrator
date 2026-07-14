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
import { retryWithBackoff } from '../../../util/backoff';
import { ErrorCategory } from '../../../../shared/types/error-recovery.types';
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
  /** Cancels a pending retry when the enclosing startup operation ends. */
  signal?: AbortSignal;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000];

/**
 * True for errors where retrying the SAME client can plausibly succeed —
 * i.e. per-RPC timeouts (starved host, busy server). Name-based check so this
 * module does not need a runtime import of ProtocolError.
 */
export function isTransientThreadStartError(error: unknown): boolean {
  return isTransientRpcTimeoutError(error);
}

/**
 * Method-agnostic transient check: a per-RPC timeout raised by the app-server
 * client (`ProtocolError: RPC timeout …`). Retrying the SAME client can
 * plausibly succeed for these (starved host, momentarily busy server), whereas
 * a closed connection or a deterministic server rejection cannot. Shared by the
 * thread/start and thread/resume retry helpers.
 */
export function isTransientRpcTimeoutError(error: unknown): boolean {
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

  return retryWithBackoff(
    () => client.request('thread/start', params),
    {
      attempts: maxAttempts,
      classify: (error) => (
        isTransientThreadStartError(error) ? ErrorCategory.TRANSIENT : ErrorCategory.PERMANENT
      ),
      delayForAttempt: (attempt) => (
        retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? 5_000
      ),
      onRetry: ({ attempt, delayMs, error }) => {
        logger.warn('thread/start timed out — retrying with backoff (host may be overloaded)', {
          attempt,
          maxAttempts,
          delayMs,
          error: error instanceof Error ? error.message : String(error),
        });
      },
      signal: options.signal,
      sleep: options.sleep ? (delayMs) => options.sleep!(delayMs) : undefined,
    },
  );
}
