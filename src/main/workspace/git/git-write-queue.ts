/**
 * GitWriteQueue — serializes orchestrator-side git write operations so
 * concurrent worktree acquires / harvests / merges / reaps do not race on
 * the shared `.git` directory.
 *
 * The queue is a single-flight promise chain: each enqueued thunk runs only
 * after the preceding one resolves or rejects. Agent-side git reads (git
 * status, git diff, etc.) are not serialized here — they are safe to run
 * concurrently because they only acquire read-locks.
 *
 * P5: the queue cannot serialize *agent-side* git writes (those run in the
 * agent's own process), so an orchestrator write can still collide with an
 * agent commit on the shared `index.lock` / ref locks. Every enqueued op is
 * therefore retried with exponential backoff when it fails with a git lock
 * error. Lock errors are transient by nature (the holder releases the lock
 * within milliseconds), so a bounded retry resolves the contention without
 * surfacing spurious failures to callers.
 *
 * Usage:
 *   const q = getGitWriteQueue();
 *   const result = await q.enqueue('commit', () => gitExec(['commit', ...], cwd));
 */

import { getLogger } from '../../logging/logger';

const logger = getLogger('GitWriteQueue');

/** Default retry policy for transient git lock errors. */
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_BASE_DELAY_MS = 40;
const DEFAULT_MAX_DELAY_MS = 1_500;

export interface GitWriteRetryConfig {
  /** Total attempts (initial try + retries). */
  maxAttempts: number;
  /** Base delay for exponential backoff (ms). */
  baseDelayMs: number;
  /** Cap on any single backoff delay (ms). */
  maxDelayMs: number;
}

export interface EnqueueOptions {
  /** Override the retry policy for this op (e.g. { maxAttempts: 1 } to disable). */
  retry?: Partial<GitWriteRetryConfig>;
}

/**
 * Detect a transient git lock error from an arbitrary thrown value. Git emits
 * these on stderr with a stable set of phrasings across operations:
 *   - "Unable to create '.../index.lock': File exists."
 *   - "fatal: Unable to create '.../shallow.lock': File exists."
 *   - "cannot lock ref 'refs/heads/...': Unable to create '.../....lock'"
 *   - "Another git process seems to be running in this repository"
 */
export function isGitLockError(err: unknown): boolean {
  const message =
    err instanceof Error
      ? `${err.message}\n${(err as { stderr?: string }).stderr ?? ''}`
      : String(err ?? '');
  const haystack = message.toLowerCase();
  if (haystack.includes('another git process seems to be running')) return true;
  if (haystack.includes('cannot lock')) return true;
  return (
    haystack.includes('.lock') &&
    (haystack.includes('file exists') || haystack.includes('unable to create'))
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GitWriteQueue {
  private static instance: GitWriteQueue | null = null;

  private tail: Promise<void> = Promise.resolve();
  private depth = 0;
  private retryConfig: GitWriteRetryConfig = {
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    baseDelayMs: DEFAULT_BASE_DELAY_MS,
    maxDelayMs: DEFAULT_MAX_DELAY_MS,
  };

  static getInstance(): GitWriteQueue {
    if (!this.instance) {
      this.instance = new GitWriteQueue();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    GitWriteQueue.instance = null;
  }

  /** Override the retry policy (primarily for tests that want zero-delay backoff). */
  configureRetry(config: Partial<GitWriteRetryConfig>): void {
    this.retryConfig = { ...this.retryConfig, ...config };
  }

  /**
   * Run `fn`, retrying with exponential backoff when it fails with a transient
   * git lock error. Non-lock errors propagate immediately (no retry).
   */
  private async runWithRetry<T>(label: string, fn: () => Promise<T>, retry: GitWriteRetryConfig): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt >= retry.maxAttempts || !isGitLockError(err)) {
          throw err;
        }
        const delay = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
        logger.warn('GitWriteQueue: git lock contention, retrying', { label, attempt, delay });
        await sleep(delay);
      }
    }
    // Unreachable: the loop either returns or throws, but satisfies the type checker.
    throw lastErr;
  }

  /**
   * Enqueue a git write operation. Returns a promise that resolves to the
   * thunk's return value only after all previously enqueued ops have settled.
   *
   * Errors from previous ops are swallowed (they resolve the chain to allow
   * the next op to run); only the error from *this* thunk propagates to the
   * caller. Transient git lock errors within the thunk are retried with
   * exponential backoff before the error is surfaced.
   */
  async enqueue<T>(label: string, fn: () => Promise<T>, options?: EnqueueOptions): Promise<T> {
    const retry: GitWriteRetryConfig = { ...this.retryConfig, ...options?.retry };

    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const outer = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.depth++;
    const depth = this.depth;
    this.tail = this.tail
      .catch(() => {
        // Swallow errors from previous ops so the queue drains.
      })
      .then(async () => {
        logger.debug('GitWriteQueue: running', { label, depth });
        try {
          const result = await this.runWithRetry(label, fn, retry);
          resolve(result);
        } catch (err) {
          reject(err);
          throw err; // Re-throw so .catch() above handles it next round.
        }
      });

    return outer;
  }

  /** How many ops have been enqueued (includes completed ones). */
  get enqueueCount(): number {
    return this.depth;
  }
}

export function getGitWriteQueue(): GitWriteQueue {
  return GitWriteQueue.getInstance();
}
