/**
 * Instance Store Type Definitions
 */

import type { AgentMode } from '../../../../../shared/types/agent.types';
import type { ActivityState } from '../../../../../shared/types/activity.types';
import type { HistoryRestoreMode } from '../../../../../shared/types/history.types';
import type {
  FailedImageRef,
  FileAttachment,
  InstanceRecoveryMethod,
  ThinkingContent,
} from '../../../../../shared/types/instance.types';
import type { ExecutionLocation } from '../../../../../shared/types/worker-node.types';

// ============================================
// Core Types
// ============================================

export type InstanceStatus =
  | 'initializing'
  | 'ready'         // Instance is fully started and available for input (alias for idle)
  | 'idle'
  | 'busy'
  | 'processing'      // CLI process alive, no output for several seconds (remote heartbeat)
  | 'thinking_deeply' // CLI process alive, no stdout for 90s+ (extended thinking)
  | 'waiting_for_input'
  | 'waiting_for_permission' // CLI paused on deferred tool use, awaiting user approval
  | 'respawning'    // Instance is recovering from interrupt, cannot be interrupted again
  | 'hibernating'   // Instance is in the process of hibernating (transitional)
  | 'hibernated'    // Instance is hibernated (resting, clickable to wake)
  | 'waking'        // Instance is waking from hibernation (transitional, like initializing)
  | 'degraded'      // Remote worker node disconnected; awaiting reconnection or failover
  | 'error'
  | 'failed'        // Instance failed to start or encountered a fatal error (alias for error)
  | 'terminated';

export interface ContextUsage {
  /** Current context-window occupancy (tokens used in the latest API call). */
  used: number;
  /** Total context-window capacity (tokens). */
  total: number;
  /** Percentage of context window used (0–100). */
  percentage: number;
  /** Lifetime token spend across all turns in this session. */
  cumulativeTokens?: number;
  /** Estimated cost in dollars */
  costEstimate?: number;
  /**
   * When true, `used` is an estimate derived from aggregate turn tokens
   * (sum of all sub-calls), NOT actual context-window occupancy.
   * The UI should display this differently to avoid misleading the user.
   */
  isEstimated?: boolean;
}

export interface OutputMessage {
  id: string;
  timestamp: number;
  type: 'assistant' | 'user' | 'system' | 'tool_use' | 'tool_result' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
  /** File attachments associated with this message. */
  attachments?: FileAttachment[];
  /** Image refs that failed to resolve into inline attachments. */
  failedImages?: FailedImageRef[];
  /** Extracted thinking/reasoning content */
  thinking?: ThinkingContent[];
  /** Whether thinking has been extracted from this message */
  thinkingExtracted?: boolean;
}

export type InstanceProvider = 'claude' | 'codex' | 'gemini' | 'ollama' | 'copilot';

export interface Instance {
  id: string;
  displayName: string;
  /** True when the user explicitly renamed this instance */
  isRenamed?: boolean;
  createdAt: number;
  historyThreadId: string;
  parentId: string | null;
  childrenIds: string[];
  agentId: string; // Agent profile ID ('build', 'plan', 'review', etc.)
  agentMode: AgentMode; // Agent mode type
  provider: InstanceProvider; // CLI provider being used
  status: InstanceStatus;
  contextUsage: ContextUsage;
  lastActivity: number;
  activityState?: ActivityState;
  currentActivity?: string; // Human-readable activity description
  currentTool?: string; // Current tool being used
  providerSessionId: string;
  sessionId: string;
  restartEpoch: number;
  recoveryMethod?: InstanceRecoveryMethod;
  archivedUpToMessageId?: string;
  workingDirectory: string;
  yoloMode: boolean;
  currentModel?: string; // Current model being used
  outputBuffer: OutputMessage[];
  /** How this instance was restored from history, if applicable */
  restoreMode?: HistoryRestoreMode;
  /** Accumulated diff stats from file content snapshots */
  diffStats?: {
    totalAdded: number;
    totalDeleted: number;
    files: Record<string, { path: string; status: 'added' | 'modified' | 'deleted'; added: number; deleted: number }>;
  };
  /** True when instance completed work (busy→idle) and user hasn't viewed it yet */
  hasUnreadCompletion?: boolean;
  /** Number of pending approval/permission requests (input_required events) */
  pendingApprovalCount?: number;
  /** Where this instance is executing (local or remote node) */
  executionLocation?: ExecutionLocation;
}

// ============================================
// Store State
// ============================================

export interface InstanceStoreState {
  instances: Map<string, Instance>;
  selectedInstanceId: string | null;
  loading: boolean;
  error: string | null;
}

// ============================================
// Message Queue Types
// ============================================

export interface QueuedMessage {
  message: string;
  files?: File[];
  retryCount?: number;
}

// ============================================
// Configuration Types
// ============================================

export interface CreateInstanceConfig {
  workingDirectory?: string;
  displayName?: string;
  parentId?: string;
  yoloMode?: boolean;
  agentId?: string;
  provider?: 'claude' | 'codex' | 'gemini' | 'copilot' | 'auto';
  model?: string;
  forceNodeId?: string;
}

// ============================================
// File Handling Constants
// ============================================

export const FILE_LIMITS = {
  MAX_IMAGE_SIZE: 5 * 1024 * 1024,     // 5MB for images (API hard limit)
  MAX_FILE_SIZE: 30 * 1024 * 1024,      // 30MB for other files (API limit)
  MAX_IMAGE_DIMENSION: 8000,            // Maximum dimension for images
} as const;
