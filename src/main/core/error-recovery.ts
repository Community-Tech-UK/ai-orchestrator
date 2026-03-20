/**
 * Error Recovery Framework
 *
 * Comprehensive error handling with:
 * - Error classification (transient vs permanent)
 * - Session recovery from checkpoints
 * - Automatic retry with exponential backoff
 * - Consecutive failure tracking
 */

import { EventEmitter } from 'events';
import {
  ClassifiedError,
  ErrorCategory,
  ErrorSeverity,
  ErrorPattern,
  ErrorRecoveryConfig,
  ErrorRecoveryEvent,
  RecoveryAction,
  RecoveryActionType,
  RecoveryPlan,
  ActionResult,
  SessionCheckpoint,
  CheckpointType,
  DEFAULT_ERROR_RECOVERY_CONFIG,
} from '../../shared/types/error-recovery.types';

/**
 * Error patterns for automatic classification
 */
const ERROR_PATTERNS: ErrorPattern[] = [
  // Rate limiting patterns
  {
    name: 'anthropic_rate_limit',
    messagePatterns: [
      /rate.?limit/i,
      /too many requests/i,
      /429/,
      /quota exceeded/i,
    ],
    codePatterns: [429, 'rate_limit_error', 'too_many_requests'],
    category: ErrorCategory.RATE_LIMITED,
    severity: ErrorSeverity.WARNING,
    recoverable: true,
    retryAfterMs: 60000, // 1 minute default
    userMessageTemplate: 'API rate limit reached. Waiting before retry.',
  },
  // Network errors
  {
    name: 'network_error',
    messagePatterns: [
      /ECONNREFUSED/i,
      /ECONNRESET/i,
      /ETIMEDOUT/i,
      /network error/i,
      /failed to fetch/i,
      /dns/i,
      /socket hang up/i,
    ],
    category: ErrorCategory.NETWORK,
    severity: ErrorSeverity.ERROR,
    recoverable: true,
    retryAfterMs: 5000,
    userMessageTemplate: 'Network connection issue. Retrying...',
  },
  // Authentication errors
  {
    name: 'auth_error',
    messagePatterns: [
      /unauthorized/i,
      /authentication/i,
      /invalid.?api.?key/i,
      /401/,
      /403/,
      /permission denied/i,
    ],
    codePatterns: [401, 403, 'authentication_error', 'invalid_api_key'],
    category: ErrorCategory.AUTH,
    severity: ErrorSeverity.CRITICAL,
    recoverable: false,
    userMessageTemplate: 'Authentication failed. Please check your API key.',
  },
  // Resource errors
  {
    name: 'out_of_memory',
    messagePatterns: [
      /out of memory/i,
      /heap/i,
      /ENOMEM/i,
      /memory allocation/i,
    ],
    category: ErrorCategory.RESOURCE,
    severity: ErrorSeverity.CRITICAL,
    recoverable: true,
    retryAfterMs: 10000,
    userMessageTemplate: 'System is low on memory. Trying to free resources.',
  },
  {
    name: 'disk_full',
    messagePatterns: [
      /disk full/i,
      /ENOSPC/i,
      /no space left/i,
      /quota exceeded/i,
    ],
    category: ErrorCategory.RESOURCE,
    severity: ErrorSeverity.CRITICAL,
    recoverable: false,
    userMessageTemplate: 'Disk is full. Please free up space.',
  },
  // Context/token errors
  {
    name: 'context_overflow',
    messagePatterns: [
      /context.?length/i,
      /token.?limit/i,
      /maximum.?tokens/i,
      /too long/i,
    ],
    codePatterns: ['context_length_exceeded', 'max_tokens_exceeded'],
    category: ErrorCategory.RESOURCE,
    severity: ErrorSeverity.WARNING,
    recoverable: true,
    userMessageTemplate: 'Context is too long. Compacting conversation.',
  },
  // Server errors (usually transient)
  {
    name: 'server_error',
    messagePatterns: [
      /500/,
      /502/,
      /503/,
      /504/,
      /internal server error/i,
      /bad gateway/i,
      /service unavailable/i,
      /gateway timeout/i,
    ],
    codePatterns: [500, 502, 503, 504],
    category: ErrorCategory.TRANSIENT,
    severity: ErrorSeverity.ERROR,
    recoverable: true,
    retryAfterMs: 5000,
    userMessageTemplate: 'Server error. Retrying...',
  },
  // Overloaded patterns
  {
    name: 'overloaded',
    messagePatterns: [
      /overloaded/i,
      /capacity/i,
      /try again later/i,
    ],
    codePatterns: ['overloaded_error'],
    category: ErrorCategory.RATE_LIMITED,
    severity: ErrorSeverity.WARNING,
    recoverable: true,
    retryAfterMs: 30000,
    userMessageTemplate: 'Service is overloaded. Waiting for capacity.',
  },
  // Timeout patterns
  {
    name: 'timeout',
    messagePatterns: [
      /timeout/i,
      /timed out/i,
      /ETIMEDOUT/i,
    ],
    category: ErrorCategory.TRANSIENT,
    severity: ErrorSeverity.WARNING,
    recoverable: true,
    retryAfterMs: 3000,
    userMessageTemplate: 'Request timed out. Retrying with extended timeout.',
  },
  // Process/CLI errors
  {
    name: 'cli_crash',
    messagePatterns: [
      /process.?exited/i,
      /SIGKILL/i,
      /SIGTERM/i,
      /process.?terminated/i,
      /spawn/i,
      /crash/i,
      /killed/i,
    ],
    category: ErrorCategory.TRANSIENT,
    severity: ErrorSeverity.ERROR,
    recoverable: true,
    retryAfterMs: 2000,
    userMessageTemplate: 'CLI process ended unexpectedly. Restarting...',
  },
  // CLI not installed
  {
    name: 'cli_not_installed',
    messagePatterns: [
      /not found/i,
      /not installed/i,
      /command not found/i,
      /ENOENT/i,
    ],
    category: ErrorCategory.PERMANENT,
    severity: ErrorSeverity.CRITICAL,
    recoverable: false,
    userMessageTemplate: 'CLI not installed. Please install the required CLI tool.',
  },
  // Parse errors
  {
    name: 'parse_error',
    messagePatterns: [
      /parse error/i,
      /unexpected token/i,
      /invalid json/i,
      /JSON\.parse/i,
    ],
    category: ErrorCategory.PERMANENT,
    severity: ErrorSeverity.WARNING,
    recoverable: false,
    userMessageTemplate: 'Failed to parse CLI output.',
  },
  // Permission denied
  {
    name: 'permission_denied',
    messagePatterns: [
      /EACCES/i,
      /EPERM/i,
    ],
    category: ErrorCategory.PERMANENT,
    severity: ErrorSeverity.ERROR,
    recoverable: false,
    userMessageTemplate: 'Permission denied. Please check file/CLI permissions.',
  },
  // Invalid input
  {
    name: 'invalid_input',
    messagePatterns: [
      /invalid input/i,
      /bad request/i,
      /validation failed/i,
      /400/,
    ],
    codePatterns: [400, 'invalid_request_error'],
    category: ErrorCategory.PERMANENT,
    severity: ErrorSeverity.WARNING,
    recoverable: false,
    userMessageTemplate: 'Invalid input provided.',
  },
];

/**
 * Error Recovery Manager
 *
 * Singleton that handles error classification, recovery planning,
 * and graceful degradation for the entire application.
 */
export class ErrorRecoveryManager extends EventEmitter {
  private static instance: ErrorRecoveryManager | null = null;

  private config: ErrorRecoveryConfig;
  private consecutiveFailures: number = 0;
  private lastFailureTime: number = 0;
  private activePlans: Map<string, RecoveryPlan> = new Map();
  private checkpoints: Map<string, SessionCheckpoint[]> = new Map();
  private errorHistory: ClassifiedError[] = [];
  private readonly maxErrorHistory = 100;

  private constructor() {
    super();
    this.config = { ...DEFAULT_ERROR_RECOVERY_CONFIG };
  }

  static getInstance(): ErrorRecoveryManager {
    if (!ErrorRecoveryManager.instance) {
      ErrorRecoveryManager.instance = new ErrorRecoveryManager();
    }
    return ErrorRecoveryManager.instance;
  }

  static _resetForTesting(): void {
    if (ErrorRecoveryManager.instance) {
      ErrorRecoveryManager.instance.destroy();
    }
    ErrorRecoveryManager.instance = null;
  }

  /**
   * Configure the error recovery system
   */
  configure(config: Partial<ErrorRecoveryConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      retry: { ...this.config.retry, ...config.retry },
      checkpoint: { ...this.config.checkpoint, ...config.checkpoint },
      notifications: { ...this.config.notifications, ...config.notifications },
    };
  }

  /**
   * Get current configuration
   */
  getConfig(): ErrorRecoveryConfig {
    return { ...this.config };
  }

  /**
   * Get consecutive failure count
   */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /**
   * Classify an error and determine recovery strategy
   */
  classifyError(error: Error, source?: string): ClassifiedError {
    const errorMessage = error.message || error.toString();
    const errorCode = (error as Error & { code?: string | number }).code;

    // Try to match against known patterns
    for (const pattern of ERROR_PATTERNS) {
      const messageMatch = pattern.messagePatterns.some(regex =>
        regex.test(errorMessage)
      );

      const codeMatch = pattern.codePatterns?.some(code => {
        if (code instanceof RegExp) {
          return code.test(String(errorCode));
        }
        return code === errorCode;
      });

      if (messageMatch || codeMatch) {
        // Extract retry-after from headers if present
        let retryAfterMs = pattern.retryAfterMs;
        const retryAfterHeader = (error as Error & { headers?: Record<string, string> }).headers?.['retry-after'];
        if (retryAfterHeader) {
          const seconds = parseInt(retryAfterHeader, 10);
          if (!isNaN(seconds)) {
            retryAfterMs = seconds * 1000;
          }
        }

        const classified: ClassifiedError = {
          original: error,
          category: pattern.category,
          severity: pattern.severity,
          recoverable: pattern.recoverable,
          retryAfterMs,
          userMessage: pattern.userMessageTemplate,
          technicalDetails: errorMessage,
          code: errorCode,
          source,
          timestamp: Date.now(),
        };

        this.recordError(classified);
        this.emitEvent({ type: 'error_classified', error: classified });
        return classified;
      }
    }

    // Default classification for unknown errors
    const classified: ClassifiedError = {
      original: error,
      category: ErrorCategory.UNKNOWN,
      severity: ErrorSeverity.ERROR,
      recoverable: false,
      userMessage: 'An unexpected error occurred.',
      technicalDetails: errorMessage,
      code: errorCode,
      source,
      timestamp: Date.now(),
    };

    this.recordError(classified);
    this.emitEvent({ type: 'error_classified', error: classified });
    return classified;
  }

  /**
   * Record error in history
   */
  private recordError(error: ClassifiedError): void {
    this.errorHistory.push(error);
    if (this.errorHistory.length > this.maxErrorHistory) {
      this.errorHistory.shift();
    }

    // Track consecutive failures
    const now = Date.now();
    if (now - this.lastFailureTime < 60000) { // Within 1 minute
      this.consecutiveFailures++;
    } else {
      this.consecutiveFailures = 1;
    }
    this.lastFailureTime = now;
  }

  /**
   * Create a recovery plan for an error
   */
  createRecoveryPlan(error: ClassifiedError): RecoveryPlan {
    const actions: RecoveryAction[] = [];
    const planId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Add actions based on error category
    switch (error.category) {
      case ErrorCategory.TRANSIENT:
      case ErrorCategory.NETWORK:
        actions.push({
          type: RecoveryActionType.RETRY,
          description: 'Retry the operation',
          priority: 1,
          requiresConfirmation: false,
          estimatedTimeMs: error.retryAfterMs || 5000,
        });
        break;

      case ErrorCategory.RATE_LIMITED:
        actions.push({
          type: RecoveryActionType.RETRY,
          description: 'Wait and retry',
          priority: 1,
          requiresConfirmation: false,
          estimatedTimeMs: error.retryAfterMs || 60000,
        });
        actions.push({
          type: RecoveryActionType.SWITCH_PROVIDER,
          description: 'Try a different provider',
          priority: 2,
          requiresConfirmation: false,
        });
        break;

      case ErrorCategory.RESOURCE:
        if (error.technicalDetails?.includes('context')) {
          actions.push({
            type: RecoveryActionType.RESTART_SESSION,
            description: 'Compact context and retry',
            priority: 1,
            requiresConfirmation: false,
          });
        } else if (error.technicalDetails?.includes('memory')) {
          actions.push({
            type: RecoveryActionType.RESTART_SESSION,
            description: 'Free memory and retry',
            priority: 1,
            requiresConfirmation: false,
          });
        }
        break;

      case ErrorCategory.AUTH:
        actions.push({
          type: RecoveryActionType.NOTIFY_USER,
          description: 'Notify user to check credentials',
          priority: 1,
          requiresConfirmation: false,
        });
        break;

      default:
        if (error.recoverable) {
          actions.push({
            type: RecoveryActionType.RETRY,
            description: 'Retry the operation',
            priority: 1,
            requiresConfirmation: false,
          });
        }
        actions.push({
          type: RecoveryActionType.NOTIFY_USER,
          description: 'Notify user of error',
          priority: 2,
          requiresConfirmation: false,
        });
    }

    // Always add checkpoint restore as fallback if available
    actions.push({
      type: RecoveryActionType.RESTORE_CHECKPOINT,
      description: 'Restore from last checkpoint',
      priority: 10,
      requiresConfirmation: true,
    });

    // Sort by priority
    actions.sort((a, b) => a.priority - b.priority);

    const plan: RecoveryPlan = {
      id: planId,
      error,
      actions,
      currentActionIndex: 0,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      actionResults: [],
    };

    this.activePlans.set(planId, plan);
    this.emitEvent({ type: 'recovery_plan_created', plan });

    return plan;
  }

  /**
   * Execute the next action in a recovery plan
   */
  async executeNextAction(planId: string): Promise<ActionResult | null> {
    const plan = this.activePlans.get(planId);
    if (!plan || plan.status === 'succeeded' || plan.status === 'failed') {
      return null;
    }

    if (plan.currentActionIndex >= plan.actions.length) {
      plan.status = 'failed';
      plan.updatedAt = Date.now();
      this.emitEvent({ type: 'recovery_completed', plan, success: false });
      return null;
    }

    const action = plan.actions[plan.currentActionIndex]!;
    plan.status = 'executing';
    plan.updatedAt = Date.now();

    this.emitEvent({ type: 'recovery_action_started', plan, action });

    const startTime = Date.now();
    let result: ActionResult;

    try {
      // Execute the action based on type
      // Note: Actual execution is delegated to the caller via events
      // This framework just tracks the state

      result = {
        action,
        success: true, // Will be set by the actual executor
        executedAt: startTime,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      result = {
        action,
        success: false,
        error: this.classifyError(error as Error, 'recovery_action'),
        executedAt: startTime,
        durationMs: Date.now() - startTime,
      };
    }

    plan.actionResults.push(result);
    plan.currentActionIndex++;
    plan.updatedAt = Date.now();

    this.emitEvent({ type: 'recovery_action_completed', plan, result });

    if (result.success) {
      plan.status = 'succeeded';
      this.emitEvent({ type: 'recovery_completed', plan, success: true });
    }

    return result;
  }

  /**
   * Mark a recovery action as completed
   */
  completeAction(planId: string, success: boolean, error?: Error): void {
    const plan = this.activePlans.get(planId);
    if (!plan || plan.actionResults.length === 0) return;

    const lastResult = plan.actionResults[plan.actionResults.length - 1]!;
    lastResult.success = success;
    lastResult.durationMs = Date.now() - lastResult.executedAt;

    if (error) {
      lastResult.error = this.classifyError(error, 'recovery_action');
    }

    plan.updatedAt = Date.now();

    if (success) {
      plan.status = 'succeeded';
      this.consecutiveFailures = 0; // Reset on success
      this.emitEvent({ type: 'recovery_completed', plan, success: true });
    }
  }

  /**
   * Cancel a recovery plan
   */
  cancelPlan(planId: string): void {
    const plan = this.activePlans.get(planId);
    if (plan) {
      plan.status = 'cancelled';
      plan.updatedAt = Date.now();
    }
  }

  /**
   * Create a checkpoint for a session
   */
  createCheckpoint(
    sessionId: string,
    type: CheckpointType,
    state: Omit<SessionCheckpoint, 'id' | 'sessionId' | 'createdAt' | 'type'>
  ): SessionCheckpoint {
    const checkpoint: SessionCheckpoint = {
      id: `ckpt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      createdAt: Date.now(),
      type,
      ...state,
    };

    // Get or create checkpoint list for session
    let sessionCheckpoints = this.checkpoints.get(sessionId);
    if (!sessionCheckpoints) {
      sessionCheckpoints = [];
      this.checkpoints.set(sessionId, sessionCheckpoints);
    }

    // Add checkpoint and enforce max limit
    sessionCheckpoints.push(checkpoint);
    while (sessionCheckpoints.length > this.config.checkpoint.maxCheckpoints) {
      sessionCheckpoints.shift();
    }

    this.emitEvent({ type: 'checkpoint_created', checkpoint });
    return checkpoint;
  }

  /**
   * Get checkpoints for a session
   */
  getCheckpoints(sessionId: string): SessionCheckpoint[] {
    return this.checkpoints.get(sessionId) || [];
  }

  /**
   * Get the latest checkpoint for a session
   */
  getLatestCheckpoint(sessionId: string): SessionCheckpoint | null {
    const checkpoints = this.checkpoints.get(sessionId);
    if (!checkpoints || checkpoints.length === 0) {
      return null;
    }
    return checkpoints[checkpoints.length - 1]!;
  }

  /**
   * Restore from a checkpoint
   */
  restoreCheckpoint(checkpointId: string): SessionCheckpoint | null {
    for (const [sessionId, checkpoints] of this.checkpoints) {
      const checkpoint = checkpoints.find(c => c.id === checkpointId);
      if (checkpoint) {
        // Remove all checkpoints after this one
        const index = checkpoints.indexOf(checkpoint);
        this.checkpoints.set(sessionId, checkpoints.slice(0, index + 1));

        this.emitEvent({ type: 'checkpoint_restored', checkpoint });
        return checkpoint;
      }
    }
    return null;
  }

  /**
   * Clear checkpoints for a session
   */
  clearCheckpoints(sessionId: string): void {
    this.checkpoints.delete(sessionId);
  }

  /**
   * Get error history
   */
  getErrorHistory(limit?: number): ClassifiedError[] {
    if (limit) {
      return this.errorHistory.slice(-limit);
    }
    return [...this.errorHistory];
  }

  /**
   * Get active recovery plans
   */
  getActivePlans(): RecoveryPlan[] {
    return Array.from(this.activePlans.values()).filter(
      plan => plan.status === 'pending' || plan.status === 'executing'
    );
  }

  /**
   * Emit a typed event
   */
  private emitEvent(event: ErrorRecoveryEvent): void {
    this.emit(event.type, event);
    this.emit('recovery_event', event);
  }

  /**
   * Reset state (for testing)
   */
  reset(): void {
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
    this.activePlans.clear();
    this.checkpoints.clear();
    this.errorHistory = [];
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.reset();
    this.removeAllListeners();
    ErrorRecoveryManager.instance = null;
  }
}

/**
 * Convenience getter for the ErrorRecoveryManager singleton
 */
export function getErrorRecoveryManager(): ErrorRecoveryManager {
  return ErrorRecoveryManager.getInstance();
}

/**
 * Retry options for the withRetry helper
 */
export interface WithRetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryCondition?: (error: ClassifiedError) => boolean;
  source?: string;
}

/**
 * Execute an async function with retry and exponential backoff.
 * Uses ErrorRecoveryManager for error classification.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: WithRetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 1000,
    maxDelayMs = 30000,
    backoffMultiplier = 2,
    retryCondition,
    source,
  } = options;

  const recovery = getErrorRecoveryManager();
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      const classified = recovery.classifyError(lastError, source);

      // Don't retry non-recoverable errors
      if (!classified.recoverable) {
        throw lastError;
      }

      // Check custom retry condition
      if (retryCondition && !retryCondition(classified)) {
        throw lastError;
      }

      // Don't wait after the last attempt
      if (attempt < maxRetries) {
        const baseDelay = initialDelayMs * Math.pow(backoffMultiplier, attempt);
        const cappedDelay = Math.min(baseDelay, maxDelayMs);
        // Add jitter (±20%)
        const jitter = cappedDelay * 0.2 * (Math.random() * 2 - 1);
        const delay = Math.round(cappedDelay + jitter);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError ?? new Error('Max retries exceeded');
}

export default ErrorRecoveryManager;
