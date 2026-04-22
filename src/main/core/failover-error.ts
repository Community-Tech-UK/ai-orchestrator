/**
 * Failover Error System
 *
 * Typed error classification for provider failover scenarios:
 * - Structured FailoverError class with reason codes
 * - Automatic classification of unknown errors
 * - Retryability determination per reason type
 */

/**
 * The reason a failover was triggered.
 *
 * - auth: Authentication or authorization failure (401, 403, invalid key)
 * - rate_limit: Too many requests or throttling (429)
 * - billing: Payment or quota issue (402, insufficient funds)
 * - timeout: Request or connection timed out
 * - process_exit: The spawned CLI process died unexpectedly
 * - context_overflow: The model's context window was exceeded
 * - unknown: Could not be classified into any of the above
 */
export type FailoverReason =
  | 'auth'
  | 'rate_limit'
  | 'billing'
  | 'timeout'
  | 'process_exit'
  | 'context_overflow'
  | 'provider_runtime'
  | 'prompt_delivery'
  | 'stale_worktree'
  | 'tool_runtime'
  | 'permission'
  | 'session_resume'
  | 'validation'
  | 'unknown';

/**
 * Reasons that are safe to retry automatically.
 */
const RETRYABLE_REASONS = new Set<FailoverReason>([
  'rate_limit',
  'timeout',
  'provider_runtime',
  'prompt_delivery',
  'tool_runtime',
  'session_resume',
  'unknown',
]);

/**
 * Options for constructing a FailoverError.
 */
export interface FailoverErrorOptions {
  reason: FailoverReason;
  provider?: string;
  model?: string;
  instanceId?: string;
  /** HTTP status code, if applicable */
  status?: number;
  /** Error code from the provider or Node.js runtime */
  code?: string;
  /** The original error that caused the failover */
  cause?: Error;
}

/**
 * FailoverError
 *
 * Represents a classified error that may trigger provider failover.
 * Carry structured metadata (reason, provider, model, instanceId) so that
 * upstream handlers can make routing and retry decisions without re-parsing
 * raw error messages.
 */
export class FailoverError extends Error {
  readonly reason: FailoverReason;
  readonly provider?: string;
  readonly model?: string;
  readonly instanceId?: string;
  readonly status?: number;
  readonly code?: string;
  readonly retryable: boolean;

  constructor(message: string, options: FailoverErrorOptions) {
    super(message);
    this.name = 'FailoverError';

    this.reason = options.reason;
    this.provider = options.provider;
    this.model = options.model;
    this.instanceId = options.instanceId;
    this.status = options.status;
    this.code = options.code;
    this.retryable = RETRYABLE_REASONS.has(options.reason);

    if (options.cause) {
      this.cause = options.cause;
    }

    // Maintain proper stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, FailoverError);
    }
  }
}

// ============ Message pattern matchers ============

const RATE_LIMIT_PATTERN = /rate.?limit|too.?many.?requests|throttl/i;
const AUTH_PATTERN = /auth|unauthorized|forbidden|invalid.?key/i;
const BILLING_PATTERN = /billing|payment|quota.?exceeded|insufficient.?funds/i;
const TIMEOUT_PATTERN = /timeout|timed?.?out|deadline/i;
const CONTEXT_OVERFLOW_PATTERN = /context.*(overflow|too.*long|exceed)|token.*limit/i;
const PROCESS_EXIT_PATTERN = /exit.*(code|status)|process.*died|spawn.*error|ENOENT/i;
const PROVIDER_RUNTIME_PATTERN = /provider runtime|provider adapter|adapter.*failed|provider unavailable/i;
const PROMPT_DELIVERY_PATTERN = /failed to deliver prompt|failed to send (?:input|message)|broken pipe|EPIPE/i;
const STALE_WORKTREE_PATTERN = /stale worktree|dirty worktree|merge conflict|needs rebase|branch .* behind/i;
const TOOL_RUNTIME_PATTERN = /tool runtime|tool execution failed|tool .* failed|command exited with code/i;
const PERMISSION_PATTERN = /approval required|permission required|sandbox denied|denied by policy|user rejected/i;
const SESSION_RESUME_PATTERN = /resume failed|failed to resume|session replay|checkpoint restore failed/i;
const VALIDATION_PATTERN = /validation failed|invalid payload|schema|zod|expected .* received/i;

// ============ Node.js error codes ============

const TIMEOUT_NODE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED']);

// ============ HTTP status code ranges ============

/**
 * Classify an HTTP status code into a FailoverReason, or return null if the
 * status code is not recognised as a failover trigger.
 */
function reasonFromStatus(status: number): FailoverReason | null {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'billing';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500 && status <= 599) return 'unknown';
  return null;
}

/**
 * Classify an error message string into a FailoverReason, or return null if
 * no pattern matches.
 */
function reasonFromMessage(message: string): FailoverReason | null {
  if (VALIDATION_PATTERN.test(message)) return 'validation';
  if (PERMISSION_PATTERN.test(message)) return 'permission';
  if (STALE_WORKTREE_PATTERN.test(message)) return 'stale_worktree';
  if (RATE_LIMIT_PATTERN.test(message)) return 'rate_limit';
  if (AUTH_PATTERN.test(message)) return 'auth';
  if (BILLING_PATTERN.test(message)) return 'billing';
  if (TIMEOUT_PATTERN.test(message)) return 'timeout';
  if (PROMPT_DELIVERY_PATTERN.test(message)) return 'prompt_delivery';
  if (SESSION_RESUME_PATTERN.test(message)) return 'session_resume';
  if (TOOL_RUNTIME_PATTERN.test(message)) return 'tool_runtime';
  if (PROVIDER_RUNTIME_PATTERN.test(message)) return 'provider_runtime';
  if (CONTEXT_OVERFLOW_PATTERN.test(message)) return 'context_overflow';
  if (PROCESS_EXIT_PATTERN.test(message)) return 'process_exit';
  return null;
}

/**
 * coerceToFailoverError
 *
 * Attempts to classify any unknown thrown value into a FailoverError.
 *
 * Classification priority:
 * 1. AbortError → returns null (user-initiated cancellation, not a failover)
 * 2. Error name checks (TimeoutError)
 * 3. HTTP status code on the error object
 * 4. Node.js error code (ETIMEDOUT, ECONNRESET, ECONNREFUSED)
 * 5. Message pattern matching
 * 6. Falls back to reason 'unknown'
 *
 * Returns null only for AbortError; all other errors yield a FailoverError.
 */
export function coerceToFailoverError(
  err: unknown,
  context?: { provider?: string; model?: string; instanceId?: string }
): FailoverError | null {
  // Treat non-Error values as unknown errors
  const error = err instanceof Error ? err : new Error(String(err));

  // User-initiated cancellation — not a failover
  if (error.name === 'AbortError') {
    return null;
  }

  // If it's already a FailoverError, return it directly (merge context if missing)
  if (error instanceof FailoverError) {
    if (!context) return error;
    // Only rebuild if context adds information
    const needsRebuild =
      (context.provider && !error.provider) ||
      (context.model && !error.model) ||
      (context.instanceId && !error.instanceId);
    if (!needsRebuild) return error;
    return new FailoverError(error.message, {
      reason: error.reason,
      provider: error.provider ?? context.provider,
      model: error.model ?? context.model,
      instanceId: error.instanceId ?? context.instanceId,
      status: error.status,
      code: error.code,
      cause: error.cause instanceof Error ? error.cause : undefined,
    });
  }

  const typedError = error as Error & {
    name?: string;
    status?: number;
    statusCode?: number;
    code?: string;
  };

  // Derived reason — resolved through the classification pipeline
  let reason: FailoverReason | null = null;

  // Check error name
  if (typedError.name === 'TimeoutError') {
    reason = 'timeout';
  }

  // Check HTTP status code (providers attach it as .status or .statusCode)
  if (reason === null) {
    const status = typedError.status ?? typedError.statusCode;
    if (typeof status === 'number') {
      reason = reasonFromStatus(status);
    }
  }

  // Check Node.js error code
  if (reason === null && typeof typedError.code === 'string') {
    if (TIMEOUT_NODE_CODES.has(typedError.code)) {
      reason = 'timeout';
    }
  }

  // Check message patterns
  if (reason === null && typedError.message) {
    reason = reasonFromMessage(typedError.message);
  }

  // Fall back to unknown
  if (reason === null) {
    reason = 'unknown';
  }

  const status = typedError.status ?? typedError.statusCode;

  return new FailoverError(typedError.message || String(err), {
    reason,
    provider: context?.provider,
    model: context?.model,
    instanceId: context?.instanceId,
    status: typeof status === 'number' ? status : undefined,
    code: typeof typedError.code === 'string' ? typedError.code : undefined,
    cause: error,
  });
}

/**
 * isFailoverError
 *
 * Type guard that checks whether a value is a FailoverError instance.
 */
export function isFailoverError(err: unknown): err is FailoverError {
  return err instanceof FailoverError;
}

/**
 * isRetryableError
 *
 * Returns true if the error is retryable.
 *
 * - If the error is already a FailoverError, uses its `retryable` flag.
 * - Otherwise, attempts to coerce the error and checks the resulting flag.
 * - Returns false for AbortError and any value that cannot be coerced.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof FailoverError) {
    return err.retryable;
  }
  const coerced = coerceToFailoverError(err);
  return coerced !== null && coerced.retryable;
}
