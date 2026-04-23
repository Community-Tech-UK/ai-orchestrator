/**
 * Error Recovery Types
 *
 * Comprehensive error handling and recovery system with:
 * - Error classification (transient vs permanent)
 * - Retry strategies with exponential backoff
 * - Session recovery and checkpointing
 */

import type { ActivityState } from './activity.types';

/**
 * Error classification for retry decisions
 */
export enum ErrorCategory {
  /** Temporary errors that may resolve on retry */
  TRANSIENT = 'transient',
  /** Permanent errors that won't resolve on retry */
  PERMANENT = 'permanent',
  /** Errors due to rate limiting */
  RATE_LIMITED = 'rate_limited',
  /** Errors due to authentication/authorization */
  AUTH = 'auth',
  /** Errors due to resource constraints (memory, disk) */
  RESOURCE = 'resource',
  /** Network connectivity errors */
  NETWORK = 'network',
  /** Provider runtime or adapter failures */
  PROVIDER_RUNTIME = 'provider_runtime',
  /** Prompt delivery or transport failures */
  PROMPT_DELIVERY = 'prompt_delivery',
  /** Stale branch/worktree or merge-state issues */
  STALE_WORKTREE = 'stale_worktree',
  /** Tool execution/runtime failures */
  TOOL_RUNTIME = 'tool_runtime',
  /** User approval, sandbox, or permission failures */
  PERMISSION = 'permission',
  /** Session replay/resume failures */
  SESSION_RESUME = 'session_resume',
  /** Schema or payload validation failures */
  VALIDATION = 'validation',
  /** Unknown/unclassified errors */
  UNKNOWN = 'unknown',
}

/**
 * Error severity levels
 */
export enum ErrorSeverity {
  /** Informational, no action needed */
  INFO = 'info',
  /** Warning, may need attention */
  WARNING = 'warning',
  /** Error that affects functionality */
  ERROR = 'error',
  /** Critical error requiring immediate attention */
  CRITICAL = 'critical',
  /** Fatal error, system cannot continue */
  FATAL = 'fatal',
}

/**
 * Classified error with recovery metadata
 */
export interface ClassifiedError {
  /** Original error */
  original: Error;
  /** Error category for retry decisions */
  category: ErrorCategory;
  /** Error severity */
  severity: ErrorSeverity;
  /** Whether this error is recoverable */
  recoverable: boolean;
  /** Suggested retry delay in ms (if applicable) */
  retryAfterMs?: number;
  /** User-friendly error message */
  userMessage: string;
  /** Technical details for debugging */
  technicalDetails?: string;
  /** Error code (e.g., HTTP status, API error code) */
  code?: string | number;
  /** Component that generated the error */
  source?: string;
  /** Structured metadata for observability and deterministic recovery */
  metadata?: Record<string, unknown>;
  /** Timestamp when error occurred */
  timestamp: number;
}

/**
 * Recovery-layer severity used by detected failures and recovery recipes.
 * This is distinct from ErrorSeverity, which models logging/impact levels.
 */
export type FailureSeverity = 'recoverable' | 'degraded' | 'fatal';

type FailureCategoryDefinitionRecord = {
  errorCategory: ErrorCategory;
  errorSeverity: ErrorSeverity;
  recoverySeverity: FailureSeverity;
  recoverable: boolean;
  defaultUserMessage: string;
};

/**
 * Canonical mapping from recipe-level failure categories to the broader
 * application-wide error recovery model.
 */
export const FAILURE_CATEGORY_DEFINITIONS = {
  thread_resume_failed: {
    errorCategory: ErrorCategory.SESSION_RESUME,
    errorSeverity: ErrorSeverity.ERROR,
    recoverySeverity: 'recoverable',
    recoverable: true,
    defaultUserMessage: 'Session resume failed and is falling back to another recovery path.',
  },
  process_exited_unexpected: {
    errorCategory: ErrorCategory.TRANSIENT,
    errorSeverity: ErrorSeverity.ERROR,
    recoverySeverity: 'recoverable',
    recoverable: true,
    defaultUserMessage: 'The agent process exited unexpectedly.',
  },
  agent_stuck_blocked: {
    errorCategory: ErrorCategory.TRANSIENT,
    errorSeverity: ErrorSeverity.WARNING,
    recoverySeverity: 'recoverable',
    recoverable: true,
    defaultUserMessage: 'The agent appears blocked and needs an interrupt or nudge.',
  },
  agent_stuck_waiting: {
    errorCategory: ErrorCategory.PERMISSION,
    errorSeverity: ErrorSeverity.WARNING,
    recoverySeverity: 'degraded',
    recoverable: false,
    defaultUserMessage: 'The agent is waiting on approval or additional input.',
  },
  mcp_server_unreachable: {
    errorCategory: ErrorCategory.NETWORK,
    errorSeverity: ErrorSeverity.WARNING,
    recoverySeverity: 'degraded',
    recoverable: true,
    defaultUserMessage: 'An MCP server could not be reached.',
  },
  provider_auth_expired: {
    errorCategory: ErrorCategory.AUTH,
    errorSeverity: ErrorSeverity.CRITICAL,
    recoverySeverity: 'fatal',
    recoverable: false,
    defaultUserMessage: 'Provider authentication expired and requires manual refresh.',
  },
  context_window_exhausted: {
    errorCategory: ErrorCategory.RESOURCE,
    errorSeverity: ErrorSeverity.WARNING,
    recoverySeverity: 'recoverable',
    recoverable: true,
    defaultUserMessage: 'The conversation exceeded the model context window.',
  },
  workspace_disappeared: {
    errorCategory: ErrorCategory.STALE_WORKTREE,
    errorSeverity: ErrorSeverity.ERROR,
    recoverySeverity: 'recoverable',
    recoverable: true,
    defaultUserMessage: 'The working directory is no longer available.',
  },
  stale_branch: {
    errorCategory: ErrorCategory.STALE_WORKTREE,
    errorSeverity: ErrorSeverity.WARNING,
    recoverySeverity: 'degraded',
    recoverable: false,
    defaultUserMessage: 'The branch or worktree is stale and needs manual attention.',
  },
  ci_feedback_loop: {
    errorCategory: ErrorCategory.UNKNOWN,
    errorSeverity: ErrorSeverity.ERROR,
    recoverySeverity: 'degraded',
    recoverable: false,
    defaultUserMessage: 'The agent is stuck in a repeated CI failure loop.',
  },
} as const satisfies Record<string, FailureCategoryDefinitionRecord>;

/** Every known failure mode gets a typed entry. */
export type FailureCategory = keyof typeof FAILURE_CATEGORY_DEFINITIONS;

export type FailureSeverityForCategory<C extends FailureCategory> =
  (typeof FAILURE_CATEGORY_DEFINITIONS)[C]['recoverySeverity'];

export type FailureCategoryDefinition<C extends FailureCategory = FailureCategory> = {
  category: C;
} & (typeof FAILURE_CATEGORY_DEFINITIONS)[C];

/** A detected failure ready for recipe-driven recovery. */
export interface DetectedFailure<C extends FailureCategory = FailureCategory> {
  /** Unique failure ID */
  id: string;
  /** Which failure category this belongs to */
  category: C;
  /** Which instance experienced this failure */
  instanceId: string;
  /** When the failure was detected (epoch ms) */
  detectedAt: number;
  /** Category-specific details */
  context: Record<string, unknown>;
  /** Activity state at detection time */
  activityState?: ActivityState;
  /** How the recovery layer should treat this failure */
  severity: FailureSeverityForCategory<C>;
}

/** A registered recovery recipe for a failure category. */
export interface RecoveryRecipe<C extends FailureCategory = FailureCategory> {
  /** Which failure category this recipe handles */
  category: C;
  /** Expected severity for this failure category */
  severity: FailureSeverityForCategory<C>;
  /** Maximum auto-recovery attempts before escalating */
  maxAutoRetries: number;
  /** Minimum time between auto-recovery attempts (ms) */
  cooldownMs: number;
  /** Execute the recovery action */
  recover: (failure: DetectedFailure<C>) => Promise<RecoveryOutcome>;
  /** Human-readable description */
  description: string;
}

/** Result of a recovery attempt. */
export type RecoveryOutcome =
  | { status: 'recovered'; action: string }
  | { status: 'degraded'; action: string }
  | { status: 'escalated'; reason: string }
  | { status: 'aborted'; reason: string };

/** A logged recovery attempt. */
export interface RecoveryAttempt<C extends FailureCategory = FailureCategory> {
  /** ID of the failure that triggered this attempt */
  failureId: string;
  /** Category of the failure */
  category: C;
  /** Instance that was recovered */
  instanceId: string;
  /** When the attempt was made (epoch ms) */
  attemptedAt: number;
  /** Outcome of the recovery */
  outcome: RecoveryOutcome;
  /** Checkpoint created before recovery (rollback point) */
  checkpointId: string;
}

/** Global circuit breaker constants for recipe-driven recovery. */
export const RECOVERY_CONSTANTS = {
  /** Max total recovery attempts per instance within the time window */
  CIRCUIT_BREAKER_MAX_ATTEMPTS: 5,
  /** Time window for circuit breaker (ms) */
  CIRCUIT_BREAKER_WINDOW_MS: 600_000, // 10 minutes
} as const;

export function getFailureCategoryDefinition<C extends FailureCategory>(category: C): FailureCategoryDefinition<C> {
  const definition = FAILURE_CATEGORY_DEFINITIONS[category];
  return {
    category,
    ...definition,
  };
}

export function createDetectedFailure<C extends FailureCategory>(
  failure: Omit<DetectedFailure<C>, 'severity'> & {
    severity?: FailureSeverityForCategory<C>;
  },
): DetectedFailure<C> {
  const severity = failure.severity ?? FAILURE_CATEGORY_DEFINITIONS[failure.category].recoverySeverity;
  return {
    ...failure,
    severity,
  };
}

export function normalizeDetectedFailure<C extends FailureCategory>(failure: DetectedFailure<C>): DetectedFailure<C> {
  const expectedSeverity = FAILURE_CATEGORY_DEFINITIONS[failure.category].recoverySeverity;
  if (failure.severity === expectedSeverity) {
    return failure;
  }

  return {
    ...failure,
    severity: expectedSeverity,
  };
}

function extractFailureTechnicalDetails(context: Record<string, unknown>): string | undefined {
  const detailKeys = ['message', 'reason', 'error', 'details', 'description'];
  for (const key of detailKeys) {
    const candidate = context[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return undefined;
}

export function classifyDetectedFailure<C extends FailureCategory>(
  failure: DetectedFailure<C>,
  source = 'detected_failure',
  metadata?: Record<string, unknown>,
): ClassifiedError {
  const normalizedFailure = normalizeDetectedFailure(failure);
  const definition = getFailureCategoryDefinition(normalizedFailure.category);

  return {
    original: new Error(definition.defaultUserMessage),
    category: definition.errorCategory,
    severity: definition.errorSeverity,
    recoverable: definition.recoverable,
    userMessage: definition.defaultUserMessage,
    technicalDetails: extractFailureTechnicalDetails(normalizedFailure.context),
    source,
    metadata: {
      failureCategory: normalizedFailure.category,
      instanceId: normalizedFailure.instanceId,
      detectedAt: normalizedFailure.detectedAt,
      activityState: normalizedFailure.activityState,
      failureContext: normalizedFailure.context,
      ...metadata,
    },
    timestamp: normalizedFailure.detectedAt,
  };
}

/**
 * Retry configuration
 */
export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxAttempts: number;
  /** Initial delay between retries in ms */
  initialDelayMs: number;
  /** Maximum delay between retries in ms */
  maxDelayMs: number;
  /** Backoff multiplier (e.g., 2 for exponential) */
  backoffMultiplier: number;
  /** Whether to add random jitter to delays */
  jitter: boolean;
  /** Jitter range as percentage (0-1) */
  jitterFactor: number;
  /** Error categories that should be retried */
  retryableCategories: ErrorCategory[];
  /** Timeout for the entire retry operation in ms */
  totalTimeoutMs?: number;
}

/**
 * Retry state tracking
 */
export interface RetryState {
  /** Current attempt number (1-indexed) */
  attempt: number;
  /** Time of first attempt */
  startedAt: number;
  /** Time of last attempt */
  lastAttemptAt: number;
  /** Errors from each attempt */
  errors: ClassifiedError[];
  /** Whether retry is still in progress */
  inProgress: boolean;
  /** Whether retry succeeded */
  succeeded: boolean;
  /** Next scheduled retry time (if applicable) */
  nextRetryAt?: number;
}

/**
 * Checkpoint data for session recovery
 */
export interface SessionCheckpoint {
  /** Unique checkpoint ID */
  id: string;
  /** Session/instance ID this checkpoint belongs to */
  sessionId: string;
  /** Timestamp when checkpoint was created */
  createdAt: number;
  /** Checkpoint type/trigger */
  type: CheckpointType;
  /** Conversation state */
  conversationState: {
    messages: ConversationMessage[];
    contextUsage: { used: number; total: number };
    lastActivityAt: number;
  };
  /** Active tasks/operations at checkpoint */
  activeTasks?: TaskCheckpoint[];
  /** Memory state (if enabled) */
  memoryState?: {
    shortTermEntries: number;
    longTermEntries: number;
    lastSyncAt: number;
  };
  /** Metadata for recovery decisions */
  metadata?: Record<string, unknown>;
}

/**
 * Checkpoint types
 */
export enum CheckpointType {
  /** Automatic periodic checkpoint */
  PERIODIC = 'periodic',
  /** Checkpoint before risky operation */
  PRE_OPERATION = 'pre_operation',
  /** Checkpoint after successful operation */
  POST_OPERATION = 'post_operation',
  /** User-triggered checkpoint */
  MANUAL = 'manual',
  /** Checkpoint triggered by error detection */
  ERROR_RECOVERY = 'error_recovery',
}

/**
 * Minimal conversation message for checkpoints
 */
export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result';
  content: string;
  timestamp: number;
  /** Truncated content hash for integrity verification */
  contentHash?: string;
}

/**
 * Task checkpoint for recovery
 */
export interface TaskCheckpoint {
  id: string;
  type: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  description: string;
  progress?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Recovery action to take
 */
export interface RecoveryAction {
  /** Type of recovery action */
  type: RecoveryActionType;
  /** Human-readable description */
  description: string;
  /** Priority (lower = higher priority) */
  priority: number;
  /** Whether this action requires user confirmation */
  requiresConfirmation: boolean;
  /** Estimated time to complete in ms */
  estimatedTimeMs?: number;
  /** Parameters for the action */
  params?: Record<string, unknown>;
}

/**
 * Types of recovery actions
 */
export enum RecoveryActionType {
  /** Retry the failed operation */
  RETRY = 'retry',
  /** Switch to a different provider/model */
  SWITCH_PROVIDER = 'switch_provider',
  /** Restore from checkpoint */
  RESTORE_CHECKPOINT = 'restore_checkpoint',
  /** Clear and restart session */
  RESTART_SESSION = 'restart_session',
  /** Notify user and wait */
  NOTIFY_USER = 'notify_user',
  /** Skip the failed operation */
  SKIP_OPERATION = 'skip_operation',
  /** Use cached/fallback response */
  USE_FALLBACK = 'use_fallback',
}

/**
 * Recovery plan containing ordered actions
 */
export interface RecoveryPlan {
  /** Unique plan ID */
  id: string;
  /** Error that triggered this plan */
  error: ClassifiedError;
  /** Ordered list of recovery actions to try */
  actions: RecoveryAction[];
  /** Current action index */
  currentActionIndex: number;
  /** Plan status */
  status: 'pending' | 'executing' | 'succeeded' | 'failed' | 'cancelled';
  /** When the plan was created */
  createdAt: number;
  /** When the plan was last updated */
  updatedAt: number;
  /** Results of executed actions */
  actionResults: ActionResult[];
}

/**
 * Result of executing a recovery action
 */
export interface ActionResult {
  action: RecoveryAction;
  success: boolean;
  error?: ClassifiedError;
  executedAt: number;
  durationMs: number;
  metadata?: Record<string, unknown>;
}

/**
 * Error recovery configuration
 */
export interface ErrorRecoveryConfig {
  /** Enable automatic error recovery */
  enabled: boolean;
  /** Default retry configuration */
  retry: RetryConfig;
  /** Checkpoint configuration */
  checkpoint: {
    /** Enable checkpointing */
    enabled: boolean;
    /** Interval between automatic checkpoints in ms */
    intervalMs: number;
    /** Maximum checkpoints to retain */
    maxCheckpoints: number;
    /** Whether to checkpoint before risky operations */
    preOperationCheckpoint: boolean;
  };
  /** Notification configuration */
  notifications: {
    /** Notify user on degradation */
    onDegradation: boolean;
    /** Notify user on recovery */
    onRecovery: boolean;
    /** Notify user on permanent errors */
    onPermanentError: boolean;
  };
}

/**
 * Error recovery events
 */
export type ErrorRecoveryEvent =
  | { type: 'error_classified'; error: ClassifiedError }
  | { type: 'retry_started'; state: RetryState; config: RetryConfig }
  | { type: 'retry_attempt'; state: RetryState; delay: number }
  | { type: 'retry_succeeded'; state: RetryState }
  | { type: 'retry_exhausted'; state: RetryState }
  | { type: 'checkpoint_created'; checkpoint: SessionCheckpoint }
  | { type: 'checkpoint_restored'; checkpoint: SessionCheckpoint }
  | { type: 'recovery_plan_created'; plan: RecoveryPlan }
  | { type: 'recovery_action_started'; plan: RecoveryPlan; action: RecoveryAction }
  | { type: 'recovery_action_completed'; plan: RecoveryPlan; result: ActionResult }
  | { type: 'recovery_completed'; plan: RecoveryPlan; success: boolean };

/**
 * Error patterns for classification
 */
export interface ErrorPattern {
  /** Pattern name for debugging */
  name: string;
  /** Error message regex patterns */
  messagePatterns: RegExp[];
  /** Error code patterns */
  codePatterns?: (string | number | RegExp)[];
  /** Resulting classification */
  category: ErrorCategory;
  /** Resulting severity */
  severity: ErrorSeverity;
  /** Whether this error is recoverable */
  recoverable: boolean;
  /** Custom retry delay in ms */
  retryAfterMs?: number;
  /** User-friendly message template */
  userMessageTemplate: string;
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitter: true,
  jitterFactor: 0.2,
  retryableCategories: [
    ErrorCategory.TRANSIENT,
    ErrorCategory.RATE_LIMITED,
    ErrorCategory.NETWORK,
    ErrorCategory.PROVIDER_RUNTIME,
    ErrorCategory.PROMPT_DELIVERY,
    ErrorCategory.TOOL_RUNTIME,
    ErrorCategory.SESSION_RESUME,
  ],
  totalTimeoutMs: 120000, // 2 minutes
};

/**
 * Default error recovery configuration
 */
export const DEFAULT_ERROR_RECOVERY_CONFIG: ErrorRecoveryConfig = {
  enabled: true,
  retry: DEFAULT_RETRY_CONFIG,
  checkpoint: {
    enabled: true,
    intervalMs: 60000, // 1 minute
    maxCheckpoints: 10,
    preOperationCheckpoint: true,
  },
  notifications: {
    onDegradation: true,
    onRecovery: true,
    onPermanentError: true,
  },
};
