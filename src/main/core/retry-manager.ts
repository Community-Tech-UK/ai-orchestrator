/**
 * Retry Manager
 *
 * Implements intelligent retry logic with:
 * - Exponential backoff with jitter
 * - Error category-aware retry decisions
 * - Configurable retry policies
 * - State tracking for monitoring
 */

import { EventEmitter } from 'events';
import {
  RetryConfig,
  RetryState,
  ClassifiedError,
  ErrorCategory,
  ErrorSeverity,
  DEFAULT_RETRY_CONFIG,
} from '../../shared/types/error-recovery.types';
import ErrorRecoveryManager from './error-recovery';

/**
 * Options for a single retry operation
 */
export interface RetryOptions<T> {
  /** The operation to retry */
  operation: () => Promise<T>;
  /** Optional name for logging/tracking */
  operationName?: string;
  /** Override default retry config */
  config?: Partial<RetryConfig>;
  /** Callback on each retry attempt */
  onRetry?: (state: RetryState, delay: number) => void;
  /** Callback on success */
  onSuccess?: (result: T, state: RetryState) => void;
  /** Callback on exhaustion */
  onExhausted?: (state: RetryState) => void;
  /** Source identifier for error classification */
  source?: string;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
}

/**
 * Result of a retry operation
 */
export interface RetryResult<T> {
  success: boolean;
  result?: T;
  state: RetryState;
  finalError?: ClassifiedError;
}

/**
 * Retry Manager
 *
 * Handles retrying operations with configurable backoff strategies.
 */
export class RetryManager extends EventEmitter {
  private static instance: RetryManager | null = null;
  private defaultConfig: RetryConfig;
  private activeRetries: Map<string, RetryState> = new Map();
  private errorRecovery: ErrorRecoveryManager;

  private constructor() {
    super();
    this.defaultConfig = { ...DEFAULT_RETRY_CONFIG };
    this.errorRecovery = ErrorRecoveryManager.getInstance();
  }

  static getInstance(): RetryManager {
    if (!RetryManager.instance) {
      RetryManager.instance = new RetryManager();
    }
    return RetryManager.instance;
  }

  static _resetForTesting(): void {
    RetryManager.instance = null;
  }

  /**
   * Configure default retry settings
   */
  configure(config: Partial<RetryConfig>): void {
    this.defaultConfig = { ...this.defaultConfig, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): RetryConfig {
    return { ...this.defaultConfig };
  }

  /**
   * Execute an operation with retry logic
   */
  async retry<T>(options: RetryOptions<T>): Promise<RetryResult<T>> {
    const config: RetryConfig = {
      ...this.defaultConfig,
      ...options.config,
    };

    const operationId = `${options.operationName || 'operation'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const state: RetryState = {
      attempt: 0,
      startedAt: Date.now(),
      lastAttemptAt: Date.now(),
      errors: [],
      inProgress: true,
      succeeded: false,
    };

    this.activeRetries.set(operationId, state);

    this.emit('retry_started', { operationId, config, state });
    this.errorRecovery.emit('retry_started', { state, config });

    try {
      const result = await this.executeWithRetry(options, config, state, operationId);
      return result;
    } finally {
      this.activeRetries.delete(operationId);
    }
  }

  /**
   * Core retry execution logic
   */
  private async executeWithRetry<T>(
    options: RetryOptions<T>,
    config: RetryConfig,
    state: RetryState,
    operationId: string
  ): Promise<RetryResult<T>> {
    const startTime = Date.now();

    while (state.attempt < config.maxAttempts) {
      // Check for abort
      if (options.abortSignal?.aborted) {
        state.inProgress = false;
        return {
          success: false,
          state,
          finalError: {
            original: new Error('Operation aborted'),
            category: ErrorCategory.PERMANENT,
            severity: ErrorSeverity.ERROR,
            recoverable: false,
            userMessage: 'Operation was cancelled',
            timestamp: Date.now(),
          },
        };
      }

      // Check total timeout
      if (config.totalTimeoutMs && Date.now() - startTime > config.totalTimeoutMs) {
        state.inProgress = false;
        return {
          success: false,
          state,
          finalError: {
            original: new Error('Total timeout exceeded'),
            category: ErrorCategory.TRANSIENT,
            severity: ErrorSeverity.ERROR,
            recoverable: false,
            userMessage: 'Operation timed out after all retries',
            timestamp: Date.now(),
          },
        };
      }

      state.attempt++;
      state.lastAttemptAt = Date.now();

      try {
        const result = await options.operation();

        // Success!
        state.succeeded = true;
        state.inProgress = false;

        this.emit('retry_succeeded', { operationId, state, attempt: state.attempt });
        this.errorRecovery.emit('retry_succeeded', { state });

        if (options.onSuccess) {
          options.onSuccess(result, state);
        }

        return {
          success: true,
          result,
          state,
        };
      } catch (error) {
        // Classify the error
        const classifiedError = this.errorRecovery.classifyError(
          error as Error,
          options.source
        );
        state.errors.push(classifiedError);

        // Check if this error category should be retried
        if (!this.shouldRetry(classifiedError, config)) {
          state.inProgress = false;

          this.emit('retry_not_retryable', {
            operationId,
            state,
            error: classifiedError,
          });

          return {
            success: false,
            state,
            finalError: classifiedError,
          };
        }

        // Check if we have attempts remaining
        if (state.attempt >= config.maxAttempts) {
          break;
        }

        // Calculate delay with backoff and jitter
        const delay = this.calculateDelay(
          state.attempt,
          config,
          classifiedError.retryAfterMs,
          classifiedError.category,
        );
        state.nextRetryAt = Date.now() + delay;

        this.emit('retry_attempt', {
          operationId,
          state,
          attempt: state.attempt,
          delay,
          error: classifiedError,
        });

        this.errorRecovery.emit('retry_attempt', { state, delay });

        if (options.onRetry) {
          options.onRetry(state, delay);
        }

        // Wait before next attempt
        await this.sleep(delay, options.abortSignal);
      }
    }

    // Exhausted all retries
    state.inProgress = false;
    const finalError = state.errors[state.errors.length - 1];

    this.emit('retry_exhausted', { operationId, state });
    this.errorRecovery.emit('retry_exhausted', { state });

    if (options.onExhausted) {
      options.onExhausted(state);
    }

    return {
      success: false,
      state,
      finalError,
    };
  }

  /**
   * Check if an error should trigger a retry
   */
  private shouldRetry(error: ClassifiedError, config: RetryConfig): boolean {
    // Never retry non-recoverable errors
    if (!error.recoverable) {
      return false;
    }

    // Check if error category is in retryable list
    return config.retryableCategories.includes(error.category);
  }

  /**
   * Calculate delay for next retry attempt
   */
  private calculateDelay(
    attempt: number,
    config: RetryConfig,
    errorRetryAfterMs?: number,
    category?: ErrorCategory,
  ): number {
    // Use error-specified delay if available and greater than calculated
    let baseDelay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);
    const rateLimitServerDelay = category === ErrorCategory.RATE_LIMITED
      && typeof errorRetryAfterMs === 'number'
      && errorRetryAfterMs > 0;
    let usingRateLimitServerDelay = false;

    if (errorRetryAfterMs && errorRetryAfterMs > baseDelay) {
      baseDelay = errorRetryAfterMs;
      usingRateLimitServerDelay = rateLimitServerDelay;
    }

    // Apply max delay cap, except for explicit Retry-After values from
    // rate-limit responses. Those server windows are authoritative and can be
    // longer than the generic retry cap.
    if (!usingRateLimitServerDelay) {
      baseDelay = Math.min(baseDelay, config.maxDelayMs);
    }

    // Apply jitter if enabled
    if (config.jitter && !usingRateLimitServerDelay) {
      const jitterRange = baseDelay * config.jitterFactor;
      const jitter = (Math.random() * 2 - 1) * jitterRange; // -jitterRange to +jitterRange
      baseDelay = Math.max(0, baseDelay + jitter);
    }

    return Math.round(baseDelay);
  }

  /**
   * Sleep with abort signal support
   */
  private sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, ms);

      if (abortSignal) {
        if (abortSignal.aborted) {
          clearTimeout(timeout);
          reject(new Error('Aborted'));
          return;
        }

        const abortHandler = () => {
          clearTimeout(timeout);
          reject(new Error('Aborted'));
        };

        abortSignal.addEventListener('abort', abortHandler, { once: true });

        // Clean up listener after timeout
        setTimeout(() => {
          abortSignal.removeEventListener('abort', abortHandler);
        }, ms + 10);
      }
    });
  }

  /**
   * Create a reusable retry wrapper for a function
   */
  wrap<T, Args extends unknown[]>(
    fn: (...args: Args) => Promise<T>,
    options?: Omit<RetryOptions<T>, 'operation'>
  ): (...args: Args) => Promise<RetryResult<T>> {
    return async (...args: Args) => {
      return this.retry({
        ...options,
        operation: () => fn(...args),
      });
    };
  }

  /**
   * Create a retry wrapper that throws on failure
   */
  wrapOrThrow<T, Args extends unknown[]>(
    fn: (...args: Args) => Promise<T>,
    options?: Omit<RetryOptions<T>, 'operation'>
  ): (...args: Args) => Promise<T> {
    return async (...args: Args) => {
      const result = await this.retry({
        ...options,
        operation: () => fn(...args),
      });

      if (!result.success) {
        throw result.finalError?.original || new Error('Retry failed');
      }

      return result.result!;
    };
  }

  /**
   * Get active retry operations
   */
  getActiveRetries(): Map<string, RetryState> {
    return new Map(this.activeRetries);
  }

  /**
   * Get number of active retries
   */
  getActiveRetryCount(): number {
    return this.activeRetries.size;
  }

  /**
   * Cancel all active retries (by triggering abort)
   * Note: Callers must pass AbortSignal to actually cancel
   */
  cancelAll(): void {
    this.emit('cancel_all');
  }

  /**
   * Reset state (for testing)
   */
  reset(): void {
    this.activeRetries.clear();
    this.defaultConfig = { ...DEFAULT_RETRY_CONFIG };
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.cancelAll();
    this.reset();
    this.removeAllListeners();
    RetryManager.instance = null;
  }
}

/**
 * Utility function for simple retry without manager
 */
export async function retryOperation<T>(
  operation: () => Promise<T>,
  config?: Partial<RetryConfig>
): Promise<T> {
  const manager = RetryManager.getInstance();
  const result = await manager.retry({
    operation,
    config,
  });

  if (!result.success) {
    throw result.finalError?.original || new Error('Retry failed');
  }

  return result.result!;
}

/**
 * Decorator for class methods to add retry logic
 */
export function withRetry(config?: Partial<RetryConfig>) {
  return function (
    target: unknown,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: unknown[]) {
      const manager = RetryManager.getInstance();
      const result = await manager.retry({
        operation: () => originalMethod.apply(this, args),
        operationName: `${(target as object).constructor?.name || 'Unknown'}.${propertyKey}`,
        config,
      });

      if (!result.success) {
        throw result.finalError?.original || new Error('Retry failed');
      }

      return result.result;
    };

    return descriptor;
  };
}

export function getRetryManager(): RetryManager {
  return RetryManager.getInstance();
}

export default RetryManager;
