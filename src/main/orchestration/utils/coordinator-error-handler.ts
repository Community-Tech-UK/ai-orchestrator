/**
 * Shared error handling utility for orchestration coordinators.
 *
 * Provides consistent error classification, retry decisions, and logging
 * across all coordinator implementations.
 */

import { getErrorRecoveryManager } from '../../core/error-recovery';
import { ClassifiedError, ErrorCategory, ErrorSeverity } from '../../../shared/types/error-recovery.types';
import { getLogger } from '../../logging/logger';
import { truncateErrorForContext } from '../../util/error-utils';

/**
 * Result of handling a coordinator error
 */
export interface CoordinatorErrorResult {
  /** The classified error with category, severity, etc. */
  classified: ClassifiedError;
  /** Whether the operation should be retried */
  shouldRetry: boolean;
  /** Delay before retry in ms (only meaningful if shouldRetry is true) */
  retryDelayMs: number;
  /** Whether the coordinator should fail immediately without further attempts */
  shouldFailFast: boolean;
  /** User-facing message describing the error */
  userMessage: string;
}

/**
 * Context for the error being handled
 */
export interface CoordinatorErrorContext {
  /** Name of the coordinator (e.g., 'DebateCoordinator') */
  coordinatorName: string;
  /** Name of the operation that failed (e.g., 'runCritiqueRound') */
  operationName: string;
  /** Current retry attempt (0-indexed) */
  attempt?: number;
  /** Maximum allowed retries (default: 3) */
  maxRetries?: number;
  /** Additional metadata for logging */
  metadata?: Record<string, unknown>;
}

/** Error categories that should never be retried */
const FAIL_FAST_CATEGORIES = new Set<ErrorCategory>([
  ErrorCategory.AUTH,
  ErrorCategory.PERMANENT,
]);

/** Default maximum retries */
const DEFAULT_MAX_RETRIES = 3;

/** Default retry delay when not specified by the error pattern */
const DEFAULT_RETRY_DELAY_MS = 5000;

/**
 * Handle an error from a coordinator operation with consistent classification,
 * retry logic, and logging.
 */
export function handleCoordinatorError(
  error: unknown,
  context: CoordinatorErrorContext,
): CoordinatorErrorResult {
  const logger = getLogger(context.coordinatorName);
  const recovery = getErrorRecoveryManager();
  const err = error instanceof Error ? error : new Error(String(error));
  const classified = recovery.classifyError(err);

  const maxRetries = context.maxRetries ?? DEFAULT_MAX_RETRIES;
  const attempt = context.attempt ?? 0;

  const shouldFailFast = FAIL_FAST_CATEGORIES.has(classified.category);
  const shouldRetry = !shouldFailFast && classified.recoverable && attempt < maxRetries;
  const retryDelayMs = classified.retryAfterMs ?? DEFAULT_RETRY_DELAY_MS;

  // Log at appropriate level based on classification
  const logData: Record<string, unknown> = {
    operation: context.operationName,
    category: classified.category,
    severity: classified.severity,
    recoverable: classified.recoverable,
    attempt,
    maxRetries,
    shouldRetry,
    shouldFailFast,
    errorContext: truncateErrorForContext(error),
    ...context.metadata,
  };

  if (shouldFailFast || classified.severity === ErrorSeverity.CRITICAL || classified.severity === ErrorSeverity.FATAL) {
    logger.error(`${context.operationName} failed (${classified.category})`, err, logData);
  } else if (shouldRetry) {
    logger.warn(`${context.operationName} failed, will retry (attempt ${attempt + 1}/${maxRetries})`, logData);
  } else {
    logger.error(`${context.operationName} failed, no more retries`, err, logData);
  }

  return {
    classified,
    shouldRetry,
    retryDelayMs,
    shouldFailFast,
    userMessage: classified.userMessage || truncateErrorForContext(error, 200),
  };
}

/**
 * Sleep for a specified duration. Useful for retry delays.
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
