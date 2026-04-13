/**
 * CLI Error Handler — CLI-specific fallback strategy layer.
 *
 * Error pattern classification has been consolidated into
 * `src/main/core/error-recovery.ts` (`ErrorRecoveryManager`). This module now
 * delegates `classifyError` and `withRetry` to that single source of truth.
 *
 * Kept here:
 *  - `CliError` enum + per-error fallback config (`DEFAULT_ERROR_HANDLERS`)
 *  - `CliErrorManager` (skip / retry / substitute / fail / compact strategy
 *    layer used by adapters during turn execution)
 *
 * @deprecated Prefer `ErrorRecoveryManager` (`getErrorRecoveryManager()`) for
 * new code. This module remains for backward compatibility with adapters that
 * still tag emitted errors with the legacy `CliError` enum.
 */

import { EventEmitter } from 'events';
import {
  getErrorRecoveryManager,
  retryWithBackoff,
  type WithRetryOptions,
} from '../core/error-recovery';
import { ErrorCategory } from '../../shared/types/error-recovery.types';

/**
 * CLI error types
 */
export enum CliError {
  NOT_INSTALLED = 'CLI_NOT_INSTALLED',
  NOT_AUTHENTICATED = 'CLI_NOT_AUTHENTICATED',
  TIMEOUT = 'CLI_TIMEOUT',
  PROCESS_CRASH = 'CLI_PROCESS_CRASH',
  PARSE_ERROR = 'CLI_PARSE_ERROR',
  PERMISSION_DENIED = 'CLI_PERMISSION_DENIED',
  NETWORK_ERROR = 'CLI_NETWORK_ERROR',
  RATE_LIMIT = 'CLI_RATE_LIMIT',
  INVALID_INPUT = 'CLI_INVALID_INPUT',
  CONTEXT_OVERFLOW = 'CLI_CONTEXT_OVERFLOW',
  UNKNOWN = 'CLI_UNKNOWN_ERROR',
}

/**
 * Fallback strategy for error handling
 * - skip: Ignore the error and continue
 * - retry: Retry the operation with backoff
 * - substitute: Use an alternative provider
 * - fail: Fail immediately with the error
 * - compact: Compact context and retry (for context overflow)
 */
export type FallbackStrategy = 'skip' | 'retry' | 'substitute' | 'fail' | 'compact';

/**
 * Error handler configuration
 */
export interface CliErrorHandler {
  error: CliError;
  fallbackStrategy: FallbackStrategy;
  maxRetries?: number;
  substituteProvider?: string;
  retryDelay?: number;
  userMessage: string;
}

/**
 * Retry options
 */
export interface RetryOptions {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  backoffFactor: number;
  retryCondition?: (error: Error) => boolean;
}

/**
 * Default error handlers
 */
export const DEFAULT_ERROR_HANDLERS: Record<CliError, CliErrorHandler> = {
  [CliError.NOT_INSTALLED]: {
    error: CliError.NOT_INSTALLED,
    fallbackStrategy: 'substitute',
    substituteProvider: 'api',
    userMessage: 'CLI not installed. Using API fallback.',
  },
  [CliError.NOT_AUTHENTICATED]: {
    error: CliError.NOT_AUTHENTICATED,
    fallbackStrategy: 'fail',
    userMessage: 'CLI not authenticated. Please configure authentication.',
  },
  [CliError.TIMEOUT]: {
    error: CliError.TIMEOUT,
    fallbackStrategy: 'retry',
    maxRetries: 2,
    retryDelay: 5000,
    userMessage: 'CLI timed out. Retrying...',
  },
  [CliError.PROCESS_CRASH]: {
    error: CliError.PROCESS_CRASH,
    fallbackStrategy: 'retry',
    maxRetries: 1,
    retryDelay: 2000,
    userMessage: 'CLI process crashed. Restarting...',
  },
  [CliError.PARSE_ERROR]: {
    error: CliError.PARSE_ERROR,
    fallbackStrategy: 'skip',
    userMessage: 'Failed to parse CLI output.',
  },
  [CliError.PERMISSION_DENIED]: {
    error: CliError.PERMISSION_DENIED,
    fallbackStrategy: 'fail',
    userMessage: 'Permission denied. Please check CLI permissions.',
  },
  [CliError.NETWORK_ERROR]: {
    error: CliError.NETWORK_ERROR,
    fallbackStrategy: 'retry',
    maxRetries: 3,
    retryDelay: 3000,
    userMessage: 'Network error. Retrying...',
  },
  [CliError.RATE_LIMIT]: {
    error: CliError.RATE_LIMIT,
    fallbackStrategy: 'retry',
    maxRetries: 3,
    retryDelay: 10000,
    userMessage: 'Rate limited. Waiting before retry...',
  },
  [CliError.INVALID_INPUT]: {
    error: CliError.INVALID_INPUT,
    fallbackStrategy: 'fail',
    userMessage: 'Invalid input provided to CLI.',
  },
  [CliError.CONTEXT_OVERFLOW]: {
    error: CliError.CONTEXT_OVERFLOW,
    fallbackStrategy: 'compact',
    maxRetries: 1,
    retryDelay: 1000,
    userMessage: 'Context is too long. Compacting conversation and retrying...',
  },
  [CliError.UNKNOWN]: {
    error: CliError.UNKNOWN,
    fallbackStrategy: 'skip',
    userMessage: 'Unknown CLI error occurred.',
  },
};

/**
 * Map an `ErrorCategory` from the unified `ErrorRecoveryManager` to the legacy
 * `CliError` enum used by adapters that still emit pre-consolidation tags.
 */
function categoryToCliError(category: ErrorCategory, message: string): CliError {
  const lower = message.toLowerCase();
  switch (category) {
    case ErrorCategory.RATE_LIMITED:
      return CliError.RATE_LIMIT;
    case ErrorCategory.NETWORK:
      return CliError.NETWORK_ERROR;
    case ErrorCategory.AUTH:
      return CliError.NOT_AUTHENTICATED;
    case ErrorCategory.RESOURCE:
      // Resource covers context overflow + memory; only context maps to a
      // legacy CliError tag — memory exhaustion has no CLI-level analogue.
      if (
        lower.includes('context') ||
        lower.includes('token') ||
        lower.includes('too long') ||
        lower.includes('prompt is too long')
      ) {
        return CliError.CONTEXT_OVERFLOW;
      }
      return CliError.UNKNOWN;
    case ErrorCategory.PERMANENT:
      if (lower.includes('not found') || lower.includes('not installed') || lower.includes('enoent')) {
        return CliError.NOT_INSTALLED;
      }
      if (lower.includes('permission') || lower.includes('denied') || lower.includes('eacces') || lower.includes('eperm')) {
        return CliError.PERMISSION_DENIED;
      }
      if (lower.includes('parse') || lower.includes('json')) {
        return CliError.PARSE_ERROR;
      }
      if (lower.includes('invalid') || lower.includes('bad request')) {
        return CliError.INVALID_INPUT;
      }
      return CliError.UNKNOWN;
    case ErrorCategory.TRANSIENT:
      if (lower.includes('timeout') || lower.includes('timed out')) {
        return CliError.TIMEOUT;
      }
      if (lower.includes('crash') || lower.includes('exited') || lower.includes('killed') || lower.includes('sigkill') || lower.includes('sigterm')) {
        return CliError.PROCESS_CRASH;
      }
      return CliError.UNKNOWN;
    case ErrorCategory.UNKNOWN:
    default:
      return CliError.UNKNOWN;
  }
}

/**
 * Classify an error into a CliError type.
 *
 * Delegates pattern matching to `ErrorRecoveryManager` (the single source of
 * truth) and maps the resulting category back to the legacy `CliError` enum
 * for adapters that still emit it.
 */
export function classifyError(error: Error | string): CliError {
  const errObj = typeof error === 'string' ? new Error(error) : error;
  const classified = getErrorRecoveryManager().classifyError(errObj, 'cli-adapter');
  return categoryToCliError(classified.category, classified.technicalDetails ?? errObj.message);
}

/**
 * Get the error handler for a specific error type
 */
export function getErrorHandler(errorType: CliError): CliErrorHandler {
  return DEFAULT_ERROR_HANDLERS[errorType] || DEFAULT_ERROR_HANDLERS[CliError.UNKNOWN];
}

/**
 * Default retry options
 */
export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffFactor: 2,
};

/**
 * Calculate delay for exponential backoff
 */
export function calculateBackoffDelay(
  attempt: number,
  options: RetryOptions = DEFAULT_RETRY_OPTIONS
): number {
  const delay = Math.min(
    options.initialDelay * Math.pow(options.backoffFactor, attempt),
    options.maxDelay
  );
  // Add jitter (±20%)
  const jitter = delay * 0.2 * (Math.random() * 2 - 1);
  return Math.round(delay + jitter);
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff.
 *
 * Delegates to `retryWithBackoff` in `ErrorRecoveryManager` so retry logic
 * lives in one place. The legacy `RetryOptions` shape is preserved for
 * callers that still reference it.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const merged = { ...DEFAULT_RETRY_OPTIONS, ...options };
  const recoveryOpts: WithRetryOptions = {
    maxRetries: merged.maxRetries,
    initialDelayMs: merged.initialDelay,
    maxDelayMs: merged.maxDelay,
    backoffMultiplier: merged.backoffFactor,
    source: 'cli-error-handler',
    // The legacy retryCondition runs against a raw Error; the unified helper
    // passes a ClassifiedError. Adapt when a custom condition is supplied.
    ...(merged.retryCondition && {
      retryCondition: (classified) =>
        merged.retryCondition!(classified.original),
    }),
  };
  return retryWithBackoff(fn, recoveryOpts);
}

/**
 * CLI Error Handler Manager
 */
export class CliErrorManager extends EventEmitter {
  private handlers = new Map<CliError, CliErrorHandler>();

  constructor() {
    super();

    // Initialize with default handlers
    for (const [error, handler] of Object.entries(DEFAULT_ERROR_HANDLERS)) {
      this.handlers.set(error as CliError, handler);
    }
  }

  /**
   * Set a custom error handler
   */
  setHandler(errorType: CliError, handler: Partial<CliErrorHandler>): void {
    const existing = this.handlers.get(errorType) || DEFAULT_ERROR_HANDLERS[errorType];
    this.handlers.set(errorType, { ...existing, ...handler });
  }

  /**
   * Handle an error and return the appropriate action
   */
  async handleError(
    error: Error | string,
    context?: { cliName?: string; operation?: string }
  ): Promise<{
    action: FallbackStrategy;
    retryCount: number;
    substituteProvider?: string;
    userMessage: string;
  }> {
    const errorType = classifyError(error);
    const handler = this.handlers.get(errorType) || DEFAULT_ERROR_HANDLERS[CliError.UNKNOWN];

    this.emit('error', {
      type: errorType,
      message: typeof error === 'string' ? error : error.message,
      handler,
      context,
    });

    return {
      action: handler.fallbackStrategy,
      retryCount: handler.maxRetries || 0,
      substituteProvider: handler.substituteProvider,
      userMessage: handler.userMessage,
    };
  }

  /**
   * Execute with error handling
   */
  async execute<T>(
    fn: () => Promise<T>,
    options?: {
      cliName?: string;
      operation?: string;
      onRetry?: (attempt: number, error: Error) => void;
      onFallback?: (provider: string) => Promise<T>;
      onCompact?: () => Promise<void>;
    }
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const { action, retryCount, substituteProvider, userMessage } = await this.handleError(
        error as Error,
        { cliName: options?.cliName, operation: options?.operation }
      );

      switch (action) {
        case 'retry':
          return withRetry(fn, {
            maxRetries: retryCount,
            retryCondition: (e) => {
              if (options?.onRetry) {
                options.onRetry(retryCount, e);
              }
              return true;
            },
          });

        case 'compact':
          // Compact context and retry once
          if (options?.onCompact) {
            this.emit('compact', { cliName: options.cliName, operation: options.operation });
            await options.onCompact();
            // Retry once after compaction
            return withRetry(fn, {
              maxRetries: retryCount,
              retryCondition: (e) => {
                if (options?.onRetry) {
                  options.onRetry(retryCount, e);
                }
                return true;
              },
            });
          }
          // If no compact handler, treat as fail
          throw new Error(`Context overflow: ${userMessage}`);

        case 'substitute':
          if (options?.onFallback && substituteProvider) {
            this.emit('fallback', { from: options.cliName, to: substituteProvider });
            return options.onFallback(substituteProvider);
          }
          throw new Error(`No fallback available: ${userMessage}`);

        case 'skip':
          throw new Error(`Skipped: ${userMessage}`);

        case 'fail':
        default:
          throw error;
      }
    }
  }
}

/**
 * Singleton instance
 */
let errorManagerInstance: CliErrorManager | null = null;

export function getCliErrorManager(): CliErrorManager {
  if (!errorManagerInstance) {
    errorManagerInstance = new CliErrorManager();
  }
  return errorManagerInstance;
}
