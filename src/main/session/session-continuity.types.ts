import type { InstanceProvider } from '../../shared/types/instance.types';

export interface SessionSnapshot {
  id: string;
  instanceId: string;
  sessionId?: string;
  historyThreadId?: string;
  timestamp: number;
  name?: string;
  description?: string;
  state: SessionState;
  schemaVersion?: number;
  metadata: {
    messageCount: number;
    tokensUsed: number;
    duration: number;
    trigger: 'auto' | 'manual' | 'checkpoint';
  };
}

export interface ResumeCursor {
  /** Provider type that owns this thread */
  provider: string;
  /** Provider-specific thread/session ID for resume */
  threadId: string;
  /** Workspace path for filesystem-based discovery fallback */
  workspacePath: string;
  /** Epoch ms when cursor was captured — used for staleness check */
  capturedAt: number;
  /** How this cursor was obtained */
  scanSource: 'native' | 'jsonl-scan' | 'thread-list' | 'replay';
  /**
   * Fingerprint of the resume-affecting config (provider/model/cwd) at capture
   * time (§6.2). On resume, if the live config differs, native resume is skipped
   * in favour of replay. Optional for backwards-compatibility with cursors
   * persisted before this field existed.
   */
  configFingerprint?: string;
}

export interface SessionState {
  instanceId: string;
  sessionId?: string;
  historyThreadId?: string;
  nativeResumeFailedAt?: number | null;
  displayName: string;
  isRenamed?: boolean;
  agentId: string;
  modelId: string;
  provider?: InstanceProvider;
  workingDirectory: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  conversationHistory: ConversationEntry[];
  contextUsage: {
    used: number;
    total: number;
    costEstimate?: number;
  };
  pendingTasks: PendingTask[];
  environmentVariables: Record<string, string>;
  activeFiles: string[];
  gitBranch?: string;
  customInstructions?: string;
  skillsLoaded: string[];
  hooksActive: string[];
  lastWriteTimestamp?: number;
  lastWriteSource?: string;
  /** Persisted resume cursor for crash-resilient session restore */
  resumeCursor?: ResumeCursor | null;
}

export interface ConversationEntry {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  tokens?: number;
  toolUse?: {
    toolName: string;
    input: unknown;
    output?: string;
  };
  thinking?: string;
  isCompacted?: boolean;
}

export interface PendingTask {
  id: string;
  type: 'completion' | 'tool_execution' | 'approval_required';
  description: string;
  createdAt: number;
  context?: unknown;
}

export interface ContinuityConfig {
  autoSaveEnabled: boolean;
  autoSaveIntervalMs: number;
  maxSnapshots: number;
  /** Global cap across ALL sessions. Oldest snapshots pruned first. */
  maxTotalSnapshots: number;
  snapshotRetentionDays: number;
  compressOldSnapshots: boolean;
  resumeOnStartup: boolean;
  preserveToolResults: boolean;
  /** Soft sizing hint for persisted history compaction, not a hard message cap. */
  maxConversationEntries: number;
  /** Number of newest state files to load into the resumable-session index at startup. 0 means unlimited. */
  maxLoadedStateFiles: number;
  encryptOnDisk: boolean;
  persistSessionContent: boolean;
  redactToolOutputs: boolean;
}

export interface ResumeOptions {
  restoreMessages?: boolean;
  restoreContext?: boolean;
  restoreTasks?: boolean;
  restoreEnvironment?: boolean;
  fromSnapshot?: string;
  /**
   * When true, validates that all parallel tool results are present in the
   * conversation history before completing resume. Logs warnings for any
   * tool_result entries that appear to have placeholders or missing content.
   */
  validateParallelToolResults?: boolean;
}
