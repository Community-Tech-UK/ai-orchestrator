/**
 * GitWriteQueue — serializes orchestrator-side git write operations so
 * concurrent worktree acquires / harvests / merges / reaps do not race on
 * the shared `.git` directory.
 *
 * The queue is a simple single-flight promise chain: each enqueued thunk runs
 * only after the preceding one resolves or rejects. Agent-side git reads (git
 * status, git diff, etc.) are not serialized here — they are safe to run
 * concurrently because they only acquire read-locks.
 *
 * Usage:
 *   const q = getGitWriteQueue();
 *   const result = await q.enqueue(() => gitExecOrThrow(['commit', ...], cwd));
 */

import { getLogger } from '../../logging/logger';

const logger = getLogger('GitWriteQueue');

export class GitWriteQueue {
  private static instance: GitWriteQueue | null = null;

  private tail: Promise<void> = Promise.resolve();
  private depth = 0;

  static getInstance(): GitWriteQueue {
    if (!this.instance) {
      this.instance = new GitWriteQueue();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    GitWriteQueue.instance = null;
  }

  /**
   * Enqueue a git write operation. Returns a promise that resolves to the
   * thunk's return value only after all previously enqueued ops have settled.
   *
   * Errors from previous ops are swallowed (they resolve the chain to allow
   * the next op to run); only the error from *this* thunk propagates to the
   * caller.
   */
  async enqueue<T>(label: string, fn: () => Promise<T>): Promise<T> {
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
          const result = await fn();
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
