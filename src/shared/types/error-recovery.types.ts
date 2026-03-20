/**
 * Error Recovery Types
 *
 * Comprehensive error handling and recovery system with:
 * - Error classification (transient vs permanent)
 * - Retry strategies with exponential backoff
 * - Session recovery and checkpointing
 */

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
  /** Timestamp when error occurred */
  timestamp: number;
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
