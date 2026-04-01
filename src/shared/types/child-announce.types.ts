/**
 * Child Announce Types - Push-based child completion notifications
 *
 * Inspired by OpenClaw's auto-announce pattern where children push
 * completion events to parents instead of parents polling.
 */

export interface ChildAnnouncement {
  /** The child instance that completed */
  childId: string;
  /** The parent instance to notify */
  parentId: string;
  /** Display name of the child */
  childName: string;
  /** Whether the child completed successfully */
  success: boolean;
  /** Compact summary of what the child accomplished */
  summary: string;
  /** Key conclusions (if any) */
  conclusions: string[];
  /** Error classification (if failed) */
  errorClassification?: ChildErrorClassification;
  /** Duration in ms */
  duration: number;
  /** Tokens consumed */
  tokensUsed: number;
  /** Timestamp of completion */
  completedAt: number;
}

export interface ChildErrorClassification {
  /** Error category for retry/escalation decisions */
  category: ChildErrorCategory;
  /** Human-readable error message */
  userMessage: string;
  /** Whether the parent should retry this task */
  retryable: boolean;
  /** Suggested action for the parent */
  suggestedAction: 'retry' | 'retry_different_model' | 'retry_different_provider' | 'escalate_to_user' | 'skip' | 'fail';
  /** Original error message (for debugging) */
  rawError?: string;
}

export type ChildErrorCategory =
  | 'timeout'           // Child timed out
  | 'context_overflow'  // Child ran out of context window
  | 'process_crash'     // Child process died unexpectedly
  | 'rate_limited'      // Provider rate limited the child
  | 'auth_failure'      // Authentication/authorization issue
  | 'network_error'     // Network connectivity issue
  | 'task_failure'      // Child reported task failure (not a system error)
  | 'stuck'             // Child detected as stuck by StuckProcessDetector
  | 'abort'             // Operation was aborted (cancellation, sibling abort)
  | 'filesystem'        // Filesystem inaccessible (ENOENT, EACCES, EPERM, etc.)
  | 'unknown';          // Unclassified error

export interface AnnounceConfig {
  /** Whether to auto-announce child completions to parent (default: true) */
  enabled: boolean;
  /** Whether to include conclusions in the announcement (default: true) */
  includeConclusions: boolean;
  /** Maximum summary length in characters (default: 2000) */
  maxSummaryLength: number;
  /** Whether to announce failures (default: true) */
  announceFailures: boolean;
}

export const DEFAULT_ANNOUNCE_CONFIG: AnnounceConfig = {
  enabled: true,
  includeConclusions: true,
  maxSummaryLength: 2000,
  announceFailures: true,
};
