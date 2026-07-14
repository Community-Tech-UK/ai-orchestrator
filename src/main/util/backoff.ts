import { ErrorCategory } from '../../shared/types/error-recovery.types';

export interface BackoffOptions {
  /** Delay before the first retry. */
  baseMs?: number;
  /** Multiplier applied for each subsequent retry. */
  factor?: number;
  /** Maximum delay before jitter. */
  maxMs?: number;
  /** Positive-only jitter as a fraction of the capped delay. */
  jitterRatio?: number;
}

export interface RetryAttemptContext {
  /** One-based retry number; the first retry after the initial call is 1. */
  attempt: number;
  category: ErrorCategory;
  delayMs: number;
  error: unknown;
}

export interface RetryWithBackoffOptions {
  /** Total calls, including the initial call. */
  attempts: number;
  /** Maps an operation failure to the application's canonical error category. */
  classify: (error: unknown) => ErrorCategory;
  backoff?: BackoffOptions;
  /**
   * Optional zero-based retry delay policy for callers migrating an existing
   * schedule. When absent, the standard exponential backoff is used.
   */
  delayForAttempt?: (attempt: number) => number;
  onRetry?: (context: RetryAttemptContext) => void;
  signal?: AbortSignal;
  /** Injectable delay seam for deterministic tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_BACKOFF: Required<BackoffOptions> = {
  baseMs: 200,
  factor: 2,
  maxMs: 32_000,
  jitterRatio: 0.1,
};

const RETRYABLE_CATEGORIES = new Set<ErrorCategory>([
  ErrorCategory.TRANSIENT,
  ErrorCategory.RATE_LIMITED,
  ErrorCategory.NETWORK,
  ErrorCategory.PROVIDER_RUNTIME,
  ErrorCategory.PROMPT_DELIVERY,
  ErrorCategory.TOOL_RUNTIME,
  ErrorCategory.SESSION_RESUME,
]);

/**
 * Return the delay for a zero-based retry attempt. Jitter is deliberately
 * positive-only: callers that have already waited for a server reset are never
 * retried earlier than their configured exponential delay.
 */
export function computeBackoff(attempt: number, options: BackoffOptions = {}): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new RangeError('Backoff attempt must be a non-negative integer.');
  }

  const settings = { ...DEFAULT_BACKOFF, ...options };
  validateSettings(settings);

  const cappedDelay = Math.min(settings.baseMs * settings.factor ** attempt, settings.maxMs);
  const jitter = settings.jitterRatio === 0 ? 0 : cappedDelay * settings.jitterRatio * Math.random();
  return Math.round(cappedDelay + jitter);
}

/** Execute an operation until it succeeds, is non-retryable, or exhausts its total attempts. */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryWithBackoffOptions,
): Promise<T> {
  if (!Number.isInteger(options.attempts) || options.attempts < 1) {
    throw new RangeError('Retry attempts must be a positive integer.');
  }

  const sleep = options.sleep ?? sleepWithAbort;
  for (let call = 0; call < options.attempts; call++) {
    throwIfAborted(options.signal);
    try {
      return await operation();
    } catch (error) {
      const category = options.classify(error);
      if (call === options.attempts - 1 || !RETRYABLE_CATEGORIES.has(category)) {
        throw error;
      }

      const delayMs = options.delayForAttempt
        ? validateDelay(options.delayForAttempt(call))
        : computeBackoff(call, options.backoff);
      options.onRetry?.({ attempt: call + 1, category, delayMs, error });
      await sleep(delayMs, options.signal);
      throwIfAborted(options.signal);
    }
  }

  throw new Error('Retry attempts exhausted without an operation result.');
}

function validateSettings(settings: Required<BackoffOptions>): void {
  if (!Number.isFinite(settings.baseMs) || settings.baseMs < 0) {
    throw new RangeError('Backoff baseMs must be a non-negative finite number.');
  }
  if (!Number.isFinite(settings.factor) || settings.factor < 1) {
    throw new RangeError('Backoff factor must be a finite number greater than or equal to 1.');
  }
  if (!Number.isFinite(settings.maxMs) || settings.maxMs < settings.baseMs) {
    throw new RangeError('Backoff maxMs must be a finite number at least as large as baseMs.');
  }
  if (!Number.isFinite(settings.jitterRatio) || settings.jitterRatio < 0) {
    throw new RangeError('Backoff jitterRatio must be a non-negative finite number.');
  }
}

function validateDelay(delayMs: number): number {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError('Retry delay must be a non-negative finite number.');
  }
  return delayMs;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException('The retry operation was aborted.', 'AbortError');
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('The retry operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
