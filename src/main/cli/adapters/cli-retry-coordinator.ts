import type { ErrorCategory } from '../../../shared/types/error-recovery.types';
import {
  retryWithBackoff,
  type BackoffOptions,
  type RetryAttemptContext,
} from '../../util/backoff';

export interface CliRetryCoordinatorDeps {
  classify: (error: unknown) => ErrorCategory;
}

export interface CliRetryRunOptions {
  /** Total calls, including the initial call. */
  attempts: number;
  /** Existing fixed schedules can migrate without changing timing. */
  retryDelaysMs?: readonly number[];
  backoff?: BackoffOptions;
  onRetry?: (context: RetryAttemptContext) => void;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Shared adapter retry policy: canonical classification plus bounded backoff. */
export class CliRetryCoordinator {
  constructor(private readonly deps: CliRetryCoordinatorDeps) {}

  run<T>(operation: () => Promise<T>, options: CliRetryRunOptions): Promise<T> {
    const retryDelaysMs = options.retryDelaysMs;
    if (retryDelaysMs && retryDelaysMs.length === 0) {
      throw new RangeError('retryDelaysMs must contain at least one delay.');
    }

    return retryWithBackoff(operation, {
      attempts: options.attempts,
      classify: this.deps.classify,
      backoff: options.backoff,
      ...(retryDelaysMs
        ? {
            delayForAttempt: (attempt: number) =>
              retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)]!,
          }
        : {}),
      onRetry: options.onRetry,
      signal: options.signal,
      sleep: options.sleep,
    });
  }
}

export type { RetryAttemptContext };
