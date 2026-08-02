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
    /**
     * LT-018: whether these numbers are a real measurement rather than the
     * create-time placeholder. Persisted so a hibernate/wake round trip does not
     * regress a reporting provider's context ring to "no data".
     *
     * Absent on records written before this field existed. Those are NOT simply
     * treated as unreported — `restoreContextUsage()`
     * (`src/main/instance/lifecycle/context-usage-restore.ts`) additionally
     * infers a real measurement from a non-zero `used`, because every path that
     * writes a placeholder or a reset writes `used: 0`. See that file for the
     * full argument; do not re-derive the rule here.
     */
    occupancyReported?: boolean;
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
  /**
   * Hard cap on retained conversation entries. `addConversationEntry` keeps the
   * newest N and drops the rest. This was previously only a soft sizing hint
   * fed to a context-pressure policy that trimmed to 51 entries once the
   * session passed 80% context; that policy is gone.
   */
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
