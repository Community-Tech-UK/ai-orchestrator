/**
 * Operation Deadline Utility
 *
 * Wraps an async operation with a hard deadline. Every long wait that can
 * wedge the harness (interrupt completion, mutex acquisition, provider slot,
 * spawn first-byte, stdin drain) should run through this wrapper so the
 * timeout path is structured — owner, phase, recovery action — instead of
 * a silent forever-hang or a raw Promise.race with an anonymous Error.
 */
import { getLogger } from '../logging/logger';

const logger = getLogger('OperationDeadline');

/** Thrown when an operation exceeds its deadline. */
export class DeadlineExceededError extends Error {
  constructor(
    public readonly operationName: string,
    public readonly deadlineMs: number,
    public readonly owner?: string,
  ) {
    super(
      `Operation "${operationName}" exceeded deadline of ${deadlineMs}ms` +
        (owner ? ` (owner: ${owner})` : ''),
    );
    this.name = 'DeadlineExceededError';
  }
}

export function isDeadlineExceeded(err: unknown): err is DeadlineExceededError {
  return err instanceof DeadlineExceededError;
}

export interface OperationDeadlineOptions<T> {
  /** Human-readable label for logs and error messages. */
  name: string;
  /** Instance / session / request id — for log correlation. */
  owner?: string;
  /** Hard ceiling in milliseconds. */
  deadlineMs: number;
  /** Optional AbortSignal; if aborted before deadline, rejects with AbortError. */
  signal?: AbortSignal;
  /**
   * Called immediately before the deadline error is thrown. Use to emit a
   * structured event, update status, or arm an escalation (e.g. terminate).
   * Must not throw — errors are caught and logged.
   */
  onTimeout?: (name: string, owner: string | undefined, deadlineMs: number) => void;
  /** The async operation to race against the deadline. */
  operation: Promise<T> | (() => Promise<T>);
}

/**
 * Race `opts.operation` against a hard deadline.
 * - Resolves with the operation result if it completes in time.
 * - Rejects with `DeadlineExceededError` on timeout (and calls `onTimeout`).
 * - Rejects with an `AbortError` if `opts.signal` is aborted.
 */
export async function withOperationDeadline<T>(
  opts: OperationDeadlineOptions<T>,
): Promise<T> {
  const { name, owner, deadlineMs, signal, onTimeout, operation } = opts;

  if (signal?.aborted) {
    throw Object.assign(new Error(`Operation "${name}" aborted before start`), { name: 'AbortError' });
  }

  const operationPromise = typeof operation === 'function' ? operation() : operation;

  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;

  try {
    const result = await new Promise<T>((resolve, reject) => {
      deadlineTimer = setTimeout(() => {
        try {
          onTimeout?.(name, owner, deadlineMs);
        } catch (callbackErr) {
          logger.warn('OperationDeadline: onTimeout callback threw', {
            name,
            owner,
            error: callbackErr instanceof Error ? callbackErr.message : String(callbackErr),
          });
        }
        logger.warn('OperationDeadline: deadline exceeded', { name, owner, deadlineMs });
        reject(new DeadlineExceededError(name, deadlineMs, owner));
      }, deadlineMs);
      if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();

      if (signal) {
        abortListener = () => {
          reject(Object.assign(new Error(`Operation "${name}" aborted`), { name: 'AbortError' }));
        };
        signal.addEventListener('abort', abortListener, { once: true });
      }

      operationPromise.then(resolve, reject);
    });

    return result;
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
  }
}
