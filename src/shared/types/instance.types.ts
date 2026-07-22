/**
 * Instance Types - Core data models for AI CLI instances
 */

import { getAgentById, getDefaultAgent, type AgentMode } from './agent.types';
import type { ActivityState } from './activity.types';
import type { ImageResolveFailureReason, ImageResolveKind } from '@contracts/schemas/image';
import type { InstanceStatus } from '@contracts/types/instance-events';
import type { CanonicalCliType } from './settings.types';
import type {
  TerminationPolicy,
  ContextInheritanceConfig,
} from './supervision.types';
import type { ExecutionLocation, NodePlacementPrefs } from './worker-node.types';
import type { InstanceRuntimeSummary, ModelRuntimeTarget } from './local-model-runtime.types';
import { createDefaultContextInheritance } from './supervision.types';
import { getProviderModelContextWindow, type ReasoningEffort } from './provider.types';

/**
 * CLI provider type for instances
 */
export type InstanceProvider = CanonicalCliType;
export type { ImageResolveFailureReason, ImageResolveKind } from '@contracts/schemas/image';
export type { InstanceStatus } from '@contracts/types/instance-events';

export type InstanceLaunchMode = 'orchestrated' | 'interactive';

export interface InstanceContextEvidenceState {
  mode: import('./settings.types').ContextEvidenceMode;
  conversationId?: string;
  ownershipSource?: 'chat-ledger' | 'instance-history';
  captureFailureCount: number;
  lastCaptureFailure?: {
    code: 'unresolved-conversation-ownership';
    reason: string;
    disposition: 'preserve-provider-output' | 'pause-before-destructive-action';
    occurredAt: number;
  };
}

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
  atMessageId?: string; // Stable message id compatibility path
  sourceMessageId?: string; // User message being edited/retried
  forkAfterMessageId?: string; // Include messages through this id before forking
  displayName?: string;
  /**
   * If set, the new fork's CLI is sent this message as soon as it spawns.
   * Used by edit-and-resend so the user message is delivered inside the
   * main-process init flow, not via the renderer's status-gated queue.
   * Avoids the race where the queue drains before the new instance reaches 'idle'.
   */
  initialPrompt?: string;
  attachments?: FileAttachment[];
  preserveRuntimeSettings?: boolean;
  supersedeSource?: boolean;
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

import type { InstanceWaitReason } from './instance-wait-reason.types';
export type { InstanceWaitReason };

/**
 * An idle instance offered to memory-pressure reclamation.
 *
 * `hasConversation` is the hibernate/terminate switch: instances holding user
 * work are hibernated (recoverable — the session stays in the list and can be
 * woken), and only empty ones are terminated.
 */
export interface IdleInstanceInfo {
  id: string;
  lastActivity: number;
  displayName: string;
  hasConversation: boolean;
}

export interface ContextUsage {
  /** Current context-window occupancy (tokens used in the latest API call). */
  used: number;
  /** Total context-window capacity (tokens). */
  total: number;
  /** Percentage of context window used (0–100). */
  percentage: number;
  /** Lifetime token spend across all turns in this session. */
  cumulativeTokens?: number;
  /** Input tokens in the provider-reported API call, when known. */
  inputTokens?: number;
  /** Output tokens in the provider-reported API call, when known. */
  outputTokens?: number;
  /** Source of the context accounting, for example provider-usage or estimate. */
  source?: string;
  /** Share of the context window attributable to prompt/input tokens. */
  promptWeight?: number;
  /** Estimated token attribution for prompt/input sources. */
  promptWeightBreakdown?: {
    systemPrompt?: number;
    mcpToolDescriptions?: number;
    skills?: number;
    plugins?: number;
    userPrompt?: number;
    other?: number;
  };
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

/**
 * Where an image reference was discovered in the assistant output.
 * - `'markdown'`: explicit `![alt](url)` syntax — a deliberate signal from the
 *   model. Failures are surfaced to the UI so misconfiguration stays visible.
 * - `'bare'`: inferred from a bare URL/path on its own line. Best-effort
 *   inference, so `unsupported` failures are silently dropped by the UI to
 *   avoid noise from prose URLs the model name-drops.
 */
export type ImageReferenceOrigin = 'markdown' | 'bare';

export interface FailedImageRef {
  src: string;
  kind: ImageResolveKind;
  reason: ImageResolveFailureReason;
  message: string;
  /**
   * How the reference was discovered. Optional for backwards compatibility
   * with persisted output buffers from earlier builds; new code always sets it.
   */
  origin?: ImageReferenceOrigin;
}

export interface CommunicationToken {
  token: string;
  targetInstanceId: string;
  permissions: ('read' | 'write' | 'control')[];
  expiresAt: number;
  createdBy: string;
}

export type InstanceRecoveryMethod = 'native' | 'replay' | 'fresh' | 'failed';

/**
 * WS9 per-instance browser-tool surface: `eager` injects every browser
 * tool schema upfront, `deferred` injects the core set plus
 * `browser.tool_search`/`browser.tool_describe`, `off` skips the
 * browser-gateway MCP server entirely for this instance. Undefined defers to
 * the global `browserMcpToolDeferral` setting.
 */
export type BrowserToolsMode = 'eager' | 'deferred' | 'off';

/**
 * Desired runtime attachment for an instance — the RuntimeReconciler's input.
 * The conversation is the durable entity; a provider/model is a replaceable
 * runtime attachment described by this shape. `model` undefined lets the
 * target provider's remembered/default model win; `reasoningEffort` undefined
 * preserves the current effort, null clears to the provider default.
 * `fastMode` is carried but not yet a change trigger (reconciler follow-up).
 * `yoloMode` undefined preserves the current permission posture.
 */
export interface DesiredRuntime {
  provider: InstanceProvider;
  model?: string;
  reasoningEffort?: ReasoningEffort | null;
  fastMode?: boolean;
  modelRuntimeTarget?: ModelRuntimeTarget;
  yoloMode?: boolean;
}

/**
 * A runtime-change request as it arrives over IPC: identical to
 * {@link DesiredRuntime} except the provider may be omitted (meaning "keep
 * the instance's current provider").
 */
export type RuntimeChangeRequest = Omit<DesiredRuntime, 'provider'> & {
  provider?: InstanceProvider;
};

/** Trusted AIO-owned conversation anchor supplied by an app-owned runtime. */
export interface EvidenceConversationOwnerReference {
  kind: 'chat';
  chatId: string;
  conversationId: string;
}

export interface Instance {
  // Identity
  id: string;
  displayName: string;
  /** True when the user explicitly renamed this instance */
  isRenamed?: boolean;
  /**
   * Cheap-model (Haiku) auto-generated title, set only when AI titling actually
   * produced a summary. Captured into the history entry on archive so closed
   * threads keep an AI-chosen name in the rail. Distinct from `displayName`,
   * which also holds the instant pre-AI fallback.
   */
  aiTitle?: string;
  createdAt: number;
  historyThreadId: string;
  /** Explicit app-owned conversation identity; provider-native ids never populate this. */
  evidenceConversationOwner?: EvidenceConversationOwnerReference;
  /** Canonical AIO conversation ownership for context evidence, when enabled. */
  contextEvidence?: InstanceContextEvidenceState;

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
  /** Session identity used by the currently attached RLM store. */
  rlmStoreSessionId?: string;
  /** Monotonic restart counter used to reject stale adapter events. */
  restartEpoch: number;
  /** Monotonic adapter-listener generation used to reject stale adapter events. */
  adapterGeneration?: number;
  /**
   * Monotonically-increasing message-generation counter.  Bumped on every
   * interrupt so queued wake messages are only consumed by the fresh process.
   * Prevents the race where a dying container (still in its SIGTERM grace
   * period) steals the message intended for its replacement.
   * (claude3.md §15 — `on_wake` column for respawn race elimination)
   */
  messageGenerationId?: number;
  /** Provider-native turn ID currently producing output, when available. */
  activeTurnId?: string;
  /** Current interrupt request id, if an interrupt/cancel is in progress. */
  interruptRequestId?: string;
  /** Epoch ms when the current interrupt was requested. */
  interruptRequestedAt?: number;
  /** Current interrupt lifecycle phase. */
  interruptPhase?: 'requested' | 'accepted' | 'completed' | 'timed-out' | 'escalated';
  /** Last turn outcome observed by lifecycle/runtime. */
  lastTurnOutcome?: 'completed' | 'interrupted' | 'cancelled' | 'failed';
  /**
   * Why the instance is currently waiting, when a wait is in progress (plan
   * §4.G). Drives the renderer's activity line / countdown so a long silent
   * spinner always has a legible reason. Cleared when the wait resolves.
   */
  waitReason?: InstanceWaitReason;
  /** Replacement instance id when this instance has been superseded by edit/fork. */
  supersededBy?: string;
  /** True when this instance was cancelled specifically for prompt edit retry. */
  cancelledForEdit?: boolean;
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
   * Tri-state guard against resuming a brand-new session before the provider
   * CLI has flushed it to disk.
   *
   * - `false`  → a fresh session was started this run and has NOT yet completed
   *              a turn, so `--resume <sessionId>` would race the CLI's initial
   *              flush and fail with "No conversation found with session ID".
   *              Recovery must replay into a fresh session instead of resuming.
   * - `true`   → at least one turn has settled (or a native resume succeeded),
   *              proving the session is on disk and safely resumable.
   * - `undefined` → unknown / not applicable (e.g. restored or woken sessions
   *              that demonstrably existed in a prior run); resume is allowed.
   *
   * Purely a runtime guard — never persisted, because the `false` window only
   * exists during a live process's first turn and never spans hibernate/wake.
   */
  providerSessionPersisted?: boolean;
  /**
   * Timestamp of the last completed respawn (interrupt or unexpected-exit).
   * Used to suppress the auto-respawn path when a user-triggered respawn
   * has just finished, so a CLI that dies seconds later doesn't immediately
   * trigger another "Session reconnected automatically" cycle on top of
   * "Interrupted — waiting for input".
   */
  lastRespawnAt?: number;
  /**
   * Transient guard used by flows that are intentionally probing native resume.
   * While this timestamp is in the future, the generic unexpected-exit handler
   * should not auto-respawn; the owner flow will observe the exit and choose
   * the correct fallback path.
   */
  autoRespawnSuppressedUntil?: number;
  workingDirectory: string;
  yoloMode: boolean; // Auto-approve all permissions
  browserToolsMode?: BrowserToolsMode; // WS9 per-instance browser tool surface; undefined = global setting decides
  hardened?: boolean; // WS13 — spawn the CLI inside the macOS Seatbelt jail (fail-closed when unavailable)
  /**
   * WS7 Phase B — ordered fallback providers this session may fail over to when
   * its recovery ladder exhausts on a provider-fault category. Empty/undefined
   * = failover off. Seeded from the global `sessionFailoverProviders` at create.
   */
  failoverProviders?: string[];
  /** WS7 Phase B — provider failovers already performed this session (budget). */
  failoverSwitches?: number;
  /** WS7 Phase B — the provider this session was failed over FROM (last switch). */
  failedOverFrom?: string;
  /**
   * Desired runtime queued while the instance was busy. Runtime changes
   * (model/provider/reasoning/yoloMode) respawn the session, which is refused
   * mid-turn; a change requested while busy is parked here and applied by the
   * RuntimeReconciler on the next transition to an input-waiting status.
   * Cleared once applied or cancelled. Undefined means no change is queued.
   */
  desiredRuntime?: DesiredRuntime;
  launchMode: InstanceLaunchMode; // Orchestrated agent loop or human-driven interactive terminal
  provider: InstanceProvider; // Which CLI provider is being used
  /** Run Claude in lightweight --bare mode when supported. Defaults false. */
  bareMode?: boolean;
  /**
   * Fast mode: trade some capability for faster output. Claude sets the CLI
   * `fastMode` settings key (Opus-only); Codex requests the `priority` service
   * tier. Resolved at spawn from config/agent/provider/global defaults and
   * toggleable live via `toggleFastMode`. Providers without support ignore it.
   */
  fastMode?: boolean;
  /**
   * Whether to use the resident-session interrupt path for Claude.
   * Normal instance spawns migrate this on so steering aborts the current turn
   * without respawning the process.
   */
  residentClaude?: boolean;
  currentModel?: string; // Current model override (e.g., 'gpt-5.3-codex')
  reasoningEffort?: ReasoningEffort; // Optional model thinking/reasoning effort override
  modelRuntimeTarget?: ModelRuntimeTarget;
  runtimeSummary?: InstanceRuntimeSummary;

  /** Where this instance is executing (local or remote node) */
  executionLocation: ExecutionLocation;

  /** Placement preferences used for this instance's remote worker selection. */
  nodePlacement?: NodePlacementPrefs;

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

  /**
   * When true, the reaction engine will send `send-to-agent` reactions to this
   * instance on CI/PR events. Requires the global reaction engine `enabled` flag
   * to also be on. Default false (opt-in per instance).
   */
  reactionsArmed?: boolean;
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
  /** Internal trusted anchor for runtimes already owned by an AIO chat. */
  evidenceConversationOwner?: EvidenceConversationOwnerReference;
  sessionId?: string;
  resume?: boolean; // Resume a previous session (requires sessionId)
  workingDirectory: string;
  initialPrompt?: string;
  /**
   * Hidden runtime-only context prepended to the initial prompt sent to the
   * provider. The visible transcript still records only `initialPrompt`.
   */
  initialContextBlock?: string;
  attachments?: FileAttachment[];
  yoloMode?: boolean;
  launchMode?: InstanceLaunchMode;
  initialOutputBuffer?: OutputMessage[]; // Pre-populate output buffer (for history restore)
  /**
   * True when this instance is a restored/resumed continuation of an existing
   * thread (history restore, native resume, thread wakeup). A restored session
   * already has an established name, so the first message after restore is a
   * continuation — not a genuine first message. Setting this unconditionally
   * suppresses auto-title re-firing (which would overwrite the original name
   * with a title derived from the follow-up message) and orchestration-prompt
   * re-prepending, independent of whether the prior transcript was loaded into
   * `initialOutputBuffer`. Unlike `isRenamed`, this is transient (not persisted)
   * and does not imply the user manually chose the title.
   */
  isRestoredSession?: boolean;
  agentId?: string; // Agent profile ID (defaults to 'build')
  modelOverride?: string; // Optional model override for the instance
  reasoningEffort?: ReasoningEffort;
  /**
   * Explicit fast-mode override for this instance. When undefined, spawn
   * resolution falls back to the per-provider / global defaults (see
   * `resolveFastMode`).
   */
  fastModeOverride?: boolean;
  provider?: InstanceProvider; // CLI provider to use (defaults to settings.defaultCli)
  modelRuntimeTarget?: ModelRuntimeTarget;
  runtimeSummary?: InstanceRuntimeSummary;
  browserToolsMode?: BrowserToolsMode; // WS9 per-instance browser tool surface; undefined = global setting decides
  hardened?: boolean; // WS13 — spawn the CLI inside the macOS Seatbelt jail (fail-closed when unavailable)
  /** WS7 Phase B — ordered fallback providers; undefined = seed from global `sessionFailoverProviders`. */
  failoverProviders?: string[];

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

  /** Internal provenance/runtime metadata for orchestration, automation, and recovery flows. */
  metadata?: Record<string, unknown>;
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
  const historyThreadId = config.historyThreadId || crypto.randomUUID();
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
    evidenceConversationOwner: config.evidenceConversationOwner,

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
    launchMode: config.launchMode ?? 'orchestrated',
    provider, // Default to auto (resolved by instance manager)
    bareMode: config.bareMode ?? false,
    reasoningEffort: config.reasoningEffort,
    executionLocation: { type: 'local' },
    nodePlacement: config.nodePlacement,
    diffStats: undefined,

    outputBuffer: config.initialOutputBuffer ? [...config.initialOutputBuffer] : [],
    outputBufferMaxSize: 1000,

    communicationTokens: new Map(),
    subscribedTo: [],

    totalTokensUsed: 0,
    requestCount: 0,
    errorCount: 0,
    restartCount: 0,
    metadata: config.metadata,
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
