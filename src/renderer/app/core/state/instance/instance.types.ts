/**
 * Instance Store Type Definitions
 */

import type { AgentMode } from '../../../../../shared/types/agent.types';
import type { HistoryRestoreMode } from '../../../../../shared/types/history.types';
import type { FileAttachment, ThinkingContent } from '../../../../../shared/types/instance.types';
import type { ExecutionLocation } from '../../../../../shared/types/worker-node.types';

// ============================================
// Core Types
// ============================================

export type InstanceStatus =
  | 'initializing'
  | 'ready'         // Instance is fully started and available for input (alias for idle)
  | 'idle'
  | 'busy'
  | 'waiting_for_input'
  | 'respawning'    // Instance is recovering from interrupt, cannot be interrupted again
  | 'hibernating'   // Instance is in the process of hibernating (transitional)
  | 'hibernated'    // Instance is hibernated (resting, clickable to wake)
  | 'waking'        // Instance is waking from hibernation (transitional, like initializing)
  | 'error'
  | 'failed'        // Instance failed to start or encountered a fatal error (alias for error)
  | 'terminated';

export interface ContextUsage {
  used: number;
  total: number;
  percentage: number;
  costEstimate?: number; // Estimated cost in dollars
}

export interface OutputMessage {
  id: string;
  timestamp: number;
  type: 'assistant' | 'user' | 'system' | 'tool_use' | 'tool_result' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
  /** File attachments for user messages */
  attachments?: FileAttachment[];
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
  currentActivity?: string; // Human-readable activity description
  currentTool?: string; // Current tool being used
  sessionId: string;
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
}

// ============================================
// File Handling Constants
// ============================================

export const FILE_LIMITS = {
  MAX_IMAGE_SIZE: 5 * 1024 * 1024,     // 5MB for images (API hard limit)
  MAX_FILE_SIZE: 30 * 1024 * 1024,      // 30MB for other files (API limit)
  MAX_IMAGE_DIMENSION: 8000,            // Maximum dimension for images
} as const;
