/**
 * Instance Types - Core data models for AI CLI instances
 */

import { getAgentById, getDefaultAgent, type AgentMode } from './agent.types';
import type { ActivityState } from './activity.types';
import type { CanonicalCliType } from './settings.types';
import type {
  TerminationPolicy,
  ContextInheritanceConfig,
} from './supervision.types';
import type { ExecutionLocation, NodePlacementPrefs } from './worker-node.types';
import { createDefaultContextInheritance } from './supervision.types';
import { getProviderModelContextWindow } from './provider.types';

/**
 * CLI provider type for instances
 */
export type InstanceProvider = CanonicalCliType;

// ============================================
// Session Export Types
// ============================================

/**
 * Exported session format (JSON)
 */
export interface ExportedSession {
  version: string; // Export format version
  exportedAt: number;
  metadata: {
    displayName: string;
    createdAt: number;
    workingDirectory: string;
    agentId: string;
    agentMode: AgentMode;
    totalMessages: number;
    contextUsage: ContextUsage;
  };
  messages: OutputMessage[];
}

/**
 * Fork configuration
 */
export interface ForkConfig {
  instanceId: string;
  atMessageIndex?: number; // Fork at specific message, defaults to latest
  displayName?: string;
  /**
   * If set, the new fork's CLI is sent this message as soon as it spawns.
   * Used by edit-and-resend so the user message is delivered inside the
   * main-process init flow, not via the renderer's status-gated queue.
   * Avoids the race where the queue drains before the new instance reaches 'idle'.
   */
  initialPrompt?: string;
}

/**
 * Plan mode state
 */
export type PlanModeState = 'off' | 'planning' | 'approved';

/**
 * Plan mode configuration
 */
export interface PlanModeConfig {
  enabled: boolean;
  state: PlanModeState;
  planContent?: string; // The plan being reviewed
  approvedAt?: number; // When the plan was approved
}

// ============================================
// Core Types
// ============================================

export type InstanceStatus =
  | 'initializing'
  | 'ready'           // Init complete, adapter spawned, waiting for first input
  | 'idle'
  | 'busy'
  | 'processing'      // CLI process alive, no output for several seconds (remote heartbeat)
  | 'thinking_deeply' // CLI process alive, no stdout for 90s+ (extended thinking)
  | 'waiting_for_input'
  | 'waiting_for_permission' // CLI paused on deferred tool use, awaiting user approval
  | 'respawning'      // Instance is recovering from interrupt, cannot be interrupted again
  | 'hibernating'     // Saving state to disk before suspend
  | 'hibernated'      // State saved, process killed, can wake
  | 'waking'          // Restoring from hibernation
  | 'degraded'        // Remote worker node disconnected; awaiting reconnection or failover
  | 'error'
  | 'failed'          // Unrecoverable init/wake failure
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
  costEstimate?: number;
  /**
   * When true, `used` is an estimate derived from aggregate turn tokens
   * (sum of all sub-calls), NOT actual context-window occupancy.
   * The UI should display this differently to avoid misleading the user.
   */
  isEstimated?: boolean;
}

/**
 * Per-file diff entry for session change tracking
 */
export interface FileDiffEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  added: number;
  deleted: number;
}

/**
 * Aggregate diff stats for an instance session.
 * Uses Record (not Map) so it survives JSON serialization without special handling.
 */
export interface SessionDiffStats {
  totalAdded: number;
  totalDeleted: number;
  files: Record<string, FileDiffEntry>;
}

/**
 * Individual thinking/reasoning block from LLM response
 */
export interface ThinkingContent {
  id: string;
  content: string;
  format: 'structured' | 'xml' | 'bracket' | 'header' | 'sdk' | 'unknown';
  timestamp?: number;
  tokenCount?: number;
}

export interface OutputMessage {
  id: string;
  timestamp: number;
  type: 'assistant' | 'user' | 'system' | 'tool_use' | 'tool_result' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
  /** File attachments associated with this message. */
  attachments?: FileAttachment[];
  /** Image references that failed to resolve into inline attachments. */
  failedImages?: FailedImageRef[];
  /** Extracted thinking/reasoning content */
  thinking?: ThinkingContent[];
  /** Whether thinking has been extracted from this message */
  thinkingExtracted?: boolean;
}

export interface FileAttachment {
  name: string;
  type: string;
  size: number;
  data: string; // data URL
}

export type ImageResolveKind = 'local' | 'remote' | 'data';

export type ImageResolveFailureReason =
  | 'too_large'
  | 'not_found'
  | 'denied'
  | 'fetch_failed'
  | 'unsupported'
  | 'timeout'
  | 'invalid_data_uri';

export interface FailedImageRef {
  src: string;
  kind: ImageResolveKind;
  reason: ImageResolveFailureReason;
  message: string;
}

export interface CommunicationToken {
  token: string;
  targetInstanceId: string;
  permissions: ('read' | 'write' | 'control')[];
  expiresAt: number;
  createdBy: string;
}

export type InstanceRecoveryMethod = 'native' | 'replay' | 'fresh' | 'failed';

export interface Instance {
  // Identity
  id: string;
  displayName: string;
  /** True when the user explicitly renamed this instance */
  isRenamed?: boolean;
  createdAt: number;
  historyThreadId: string;

  // Hierarchy
  parentId: string | null;
  childrenIds: string[];
  supervisorNodeId: string;
  workerNodeId?: string; // Worker node ID in supervision tree
  depth: number; // Depth in hierarchy (0 = root)

  // Phase 2: Termination & Inheritance
  terminationPolicy: TerminationPolicy;
  contextInheritance: ContextInheritanceConfig;

  // Agent mode
  agentId: string; // References AgentProfile.id ('build', 'plan', 'review', or custom)
  agentMode: AgentMode;

  // Plan mode state
  planMode: PlanModeConfig;

  // State
  status: InstanceStatus;
  contextUsage: ContextUsage;
  lastActivity: number;
  /** Provider-level activity state (separate from InstanceStatus) */
  activityState?: ActivityState;
  currentActivity?: string; // Human-readable activity description
  currentTool?: string; // Current tool being used

  // CLI process
  processId: number | null;
  /**
   * Backend session handle for the active provider conversation.
   * Preserved on native resume, replaced on replay fallback or fresh restart.
   */
  providerSessionId: string;
  /** Deprecated alias retained during the provider/history identity split. */
  sessionId: string;
  /** Monotonic restart counter used to reject stale adapter events. */
  restartEpoch: number;
  /** How the active session was recovered after the last restart attempt. */
  recoveryMethod?: InstanceRecoveryMethod;
  /**
   * MVP transcript boundary marker for fresh restarts.
   * Prompt construction should ignore messages at or before this id.
   */
  archivedUpToMessageId?: string;
  /**
   * Set to true when we've observed that `--resume sessionId` cannot succeed
   * (e.g. Claude CLI emitted "No conversation found with session ID …").
   * The next respawn forces a fresh session + replay instead of retrying
   * the known-bad id, breaking the "No conversation found" → auto-respawn
   * → "No conversation found" loop.
   */
  sessionResumeBlacklisted?: boolean;
  /**
   * Timestamp of the last completed respawn (interrupt or unexpected-exit).
   * Used to suppress the auto-respawn path when a user-triggered respawn
   * has just finished, so a CLI that dies seconds later doesn't immediately
   * trigger another "Session reconnected automatically" cycle on top of
   * "Interrupted — waiting for input".
   */
  lastRespawnAt?: number;
  workingDirectory: string;
  yoloMode: boolean; // Auto-approve all permissions
  provider: InstanceProvider; // Which CLI provider is being used
  currentModel?: string; // Current model override (e.g., 'gpt-5.3-codex')

  /** Where this instance is executing (local or remote node) */
  executionLocation: ExecutionLocation;

  /** Accumulated diff stats for the session (file content snapshots) */
  diffStats?: SessionDiffStats;

  // Output
  outputBuffer: OutputMessage[];
  outputBufferMaxSize: number;

  // Communication
  communicationTokens: Map<string, CommunicationToken>;
  subscribedTo: string[];

  // Lifecycle promises (not serialized)
  /** Resolves when init/wake completes. sendInput() awaits this. */
  readyPromise?: Promise<void>;
  /** Resolves when respawn-after-interrupt completes. sendInput() awaits this. */
  respawnPromise?: Promise<void>;
  /** Signals cancellation of in-progress init/wake. */
  abortController?: AbortController;

  // Metrics
  totalTokensUsed: number;
  requestCount: number;
  errorCount: number;
  restartCount: number;

  /** Extensible metadata bag (e.g. toolFilter for proactive tool filtering) */
  metadata?: Record<string, unknown>;
}

export interface InstanceCreateConfig {
  displayName?: string;
  /**
   * True when the `displayName` was explicitly set by the user (e.g. carried
   * over from a restored history entry). Prevents auto-title from overwriting
   * a user-chosen name on the first message after restore.
   */
  isRenamed?: boolean;
  parentId?: string | null;
  historyThreadId?: string; // Stable app-level thread identity across restore/fallback
  sessionId?: string;
  resume?: boolean; // Resume a previous session (requires sessionId)
  workingDirectory: string;
  initialPrompt?: string;
  attachments?: FileAttachment[];
  yoloMode?: boolean;
  initialOutputBuffer?: OutputMessage[]; // Pre-populate output buffer (for history restore)
  agentId?: string; // Agent profile ID (defaults to 'build')
  modelOverride?: string; // Optional model override for the instance
  provider?: InstanceProvider; // CLI provider to use (defaults to settings.defaultCli)

  // Phase 2: Hierarchical instance options
  terminationPolicy?: TerminationPolicy; // What happens to children when this instance terminates
  contextInheritance?: Partial<ContextInheritanceConfig>; // Context inheritance settings

  /**
   * Bare mode: skip hooks, plugins, RLM, and session tracking for lightweight
   * internal orchestration spawns (verification, debate sub-instances).
   * Reduces startup overhead and resource usage for ephemeral instances.
   * Inspired by Claude Code 2.1.81 --bare flag for scripted calls.
   */
  bareMode?: boolean;

  /** Placement preferences for remote execution */
  nodePlacement?: NodePlacementPrefs;

  /** Force execution on a specific node (overrides placement logic) */
  forceNodeId?: string;
}

export interface InstanceSummary {
  id: string;
  displayName: string;
  status: InstanceStatus;
  contextUsage: ContextUsage;
  childrenCount: number;
  lastActivity: number;
  agentId: string;
  agentMode: AgentMode;
}

/**
 * Factory function for creating new instances
 */
export function createInstance(config: InstanceCreateConfig): Instance {
  const now = Date.now();
  const sessionId = config.sessionId || crypto.randomUUID();
  const historyThreadId = config.historyThreadId || sessionId;
  const provider = config.provider || 'auto';
  const agent = config.agentId
    ? getAgentById(config.agentId)
    : getDefaultAgent();
  const resolvedAgent = agent || getDefaultAgent();

  // Merge context inheritance with defaults
  const defaultInheritance = createDefaultContextInheritance();
  const contextInheritance: ContextInheritanceConfig = {
    ...defaultInheritance,
    ...config.contextInheritance,
  };

  return {
    id: crypto.randomUUID(),
    displayName: config.displayName || (config.workingDirectory && config.workingDirectory.split(/[/\\]/).filter(Boolean).pop()) || `Instance ${now}`,
    createdAt: now,
    historyThreadId,

    parentId: config.parentId || null,
    childrenIds: [],
    supervisorNodeId: '',
    workerNodeId: undefined,
    depth: 0, // Will be set by lifecycle manager based on parent

    // Phase 2: Termination & Inheritance
    terminationPolicy: config.terminationPolicy || 'terminate-children',
    contextInheritance,

    agentId: resolvedAgent.id,
    agentMode: resolvedAgent.mode,

    planMode: {
      enabled: false,
      state: 'off'
    },

    status: 'initializing',
    contextUsage: {
      used: 0,
      total: getProviderModelContextWindow(provider, config.modelOverride),
      percentage: 0
    },
    lastActivity: now,

    processId: null,
    providerSessionId: sessionId,
    sessionId,
    restartEpoch: 0,
    workingDirectory: config.workingDirectory,
    yoloMode: config.yoloMode ?? false, // Default to YOLO mode disabled
    provider, // Default to auto (resolved by instance manager)
    executionLocation: { type: 'local' },
    diffStats: undefined,

    outputBuffer: config.initialOutputBuffer || [],
    outputBufferMaxSize: 1000,

    communicationTokens: new Map(),
    subscribedTo: [],

    totalTokensUsed: 0,
    requestCount: 0,
    errorCount: 0,
    restartCount: 0
  };
}

/**
 * Serialize instance for IPC (Maps to Objects)
 */
export function serializeInstance(instance: Instance): Record<string, unknown> {
  return {
    ...instance,
    communicationTokens: Object.fromEntries(instance.communicationTokens)
  };
}

/**
 * Deserialize instance from IPC (Objects to Maps)
 */
export function deserializeInstance(data: Record<string, unknown>): Instance {
  return {
    ...(data as unknown as Instance),
    communicationTokens: new Map(
      Object.entries(
        (data['communicationTokens'] as Record<string, CommunicationToken>) ||
          {}
      )
    )
  };
}
