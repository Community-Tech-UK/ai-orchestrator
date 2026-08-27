/**
 * Instance Store Type Definitions
 */

import type { AgentMode } from '../../../../../shared/types/agent.types';
import type { ActivityState } from '../../../../../shared/types/activity.types';
import type { HistoryRestoreMode } from '../../../../../shared/types/history.types';
import type { ReasoningEffort } from '../../../../../shared/types/provider.types';
import type { CopilotRouteSource } from '../../../../../shared/types/copilot-account.types';
import type {
  InstanceRuntimeSummary,
  ModelRuntimeTarget,
} from '../../../../../shared/types/local-model-runtime.types';
import type { ProviderPromptWeightBreakdown } from '@contracts/types/provider-runtime-events';
import type {
  FailedImageRef,
  FileAttachment,
  InstanceContextEvidenceState,
  InstanceLaunchMode as SharedInstanceLaunchMode,
  InstanceStatus as SharedInstanceStatus,
  InstanceRecoveryMethod,
  InstanceWaitReason,
  DesiredRuntime,
  ThinkingContent,
} from '../../../../../shared/types/instance.types';
import type { ExecutionLocation } from '../../../../../shared/types/worker-node.types';
import type { ComputerUseAutonomyLevel } from '../../../../../shared/types/desktop-gateway-settings.types';

// ============================================
// Core Types
// ============================================

export type InstanceStatus = SharedInstanceStatus;

export interface ContextUsage {
  /** Current context-window occupancy (tokens used in the latest API call). */
  used: number;
  /** Total context-window capacity (tokens). */
  total: number;
  /** Percentage of context window used (0–100). */
  percentage: number;
  /**
   * True once a provider has actually reported occupancy (LT-018). Absent means
   * the numbers are a seeded placeholder, so the UI shows no-data, not 0 %.
   */
  occupancyReported?: boolean;
  /**
   * True when `used`/`percentage` are cumulative turn *spend*, not context-window
   * occupancy (LT-034). Providers declaring `occupancyReporting: 'aggregate-only'`
   * have no occupancy to report; rendering their running total as a window
   * percentage pins the ring at a confident 100 % over a near-empty context.
   */
  occupancyIsAggregate?: boolean;
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
  /** Breakdown of estimated prompt/context contributors, when available. */
  promptWeightBreakdown?: ProviderPromptWeightBreakdown;
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

export type InstanceProvider = 'claude' | 'codex' | 'gemini' | 'antigravity' | 'ollama' | 'copilot' | 'cursor' | 'grok';
export type InstanceLaunchMode = SharedInstanceLaunchMode;

export interface Instance {
  id: string;
  displayName: string;
  /** True when the user explicitly renamed this instance */
  isRenamed?: boolean;
  createdAt: number;
  historyThreadId: string;
  /**
   * Canonical AIO conversation ownership for context evidence, when enabled.
   * Populated over IPC by the main process (see `serializeInstance`); this
   * type mirrors that already-transmitted field so renderer scope derivation
   * for the context evidence panel never fabricates a conversation id.
   */
  contextEvidence?: InstanceContextEvidenceState;
  parentId: string | null;
  childrenIds: string[];
  agentId: string; // Agent profile ID ('build', 'plan', 'review', etc.)
  agentMode: AgentMode; // Agent mode type
  provider: InstanceProvider; // CLI provider being used
  /**
   * The GitHub Copilot account profile this session was created under, mirrored
   * from the main-process record (see `serializeInstance`). The renderer shows
   * it as provenance; it never derives a home path or re-routes from it.
   */
  copilotAccountProfileId?: string;
  /** How that account was chosen, for the badge tooltip. */
  copilotRoutingSource?: CopilotRouteSource;
  status: InstanceStatus;
  contextUsage: ContextUsage;
  lastActivity: number;
  activityState?: ActivityState;
  currentActivity?: string; // Human-readable activity description
  currentTool?: string; // Current tool being used
  providerSessionId: string;
  sessionId: string;
  restartEpoch: number;
  adapterGeneration?: number;
  activeTurnId?: string;
  interruptRequestId?: string;
  interruptRequestedAt?: number;
  interruptPhase?: 'requested' | 'accepted' | 'completed' | 'timed-out' | 'escalated';
  lastTurnOutcome?: 'completed' | 'interrupted' | 'cancelled' | 'failed';
  supersededBy?: string;
  cancelledForEdit?: boolean;
  recoveryMethod?: InstanceRecoveryMethod;
  archivedUpToMessageId?: string;
  workingDirectory: string;
  yoloMode: boolean;
  /** Process-local Computer Use policy override for this live session. */
  computerUseMode?: ComputerUseAutonomyLevel;
  /**
   * Desired YOLO mode queued while the instance is busy; applied automatically
   * once it goes idle. Undefined when no change is pending. Drives the ⚡ button's
   * pending affordance.
   */
  pendingYoloMode?: boolean;
  /** WS7 Phase B — fallback providers this session may switch to (wire field). */
  failoverProviders?: string[];
  /** WS13 — this session's CLI runs inside the macOS Seatbelt jail (wire field). */
  hardened?: boolean;
  /**
   * Provider/model change queued while the instance is busy; applied
   * automatically once it next waits for input. Undefined when no change is
   * pending. Drives the model picker's pending badge.
   */
  desiredRuntime?: DesiredRuntime;
  /** Fast mode: faster output at some capability cost (Claude Opus / Codex priority tier). */
  fastMode?: boolean;
  launchMode: InstanceLaunchMode;
  currentModel?: string; // Current model being used
  reasoningEffort?: ReasoningEffort; // Optional thinking/reasoning effort override
  runtimeSummary?: InstanceRuntimeSummary;
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
  /** Extensible backend metadata, including orchestration task/routing details for child instances. */
  metadata?: Record<string, unknown>;
  /** Machine-readable wait reason for UI display (Phase 6 / §G). Set during backoff, interrupt-ack, respawning, etc. */
  waitReason?: InstanceWaitReason;
  /**
   * True when the instance's adapter self-manages context auto-compaction
   * (Claude CLI always; Codex in app-server mode). When set, the orchestrator
   * does not auto-compact this instance, so the context-warning banner is
   * suppressed. Populated from the live adapter capabilities by the backend.
   */
  selfManagesAutoCompaction?: boolean;
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
  kind?: 'queue' | 'steer';
  hadAttachmentsDropped?: boolean;
  seededAlready?: boolean;
  /** True while this entry's durable send-queue row is unconfirmed or failed to persist (WS-A1 review Finding 1). */
  notDurable?: boolean;
}

// ============================================
// Configuration Types
// ============================================

export interface CreateInstanceConfig {
  workingDirectory?: string;
  displayName?: string;
  parentId?: string;
  yoloMode?: boolean;
  launchMode?: InstanceLaunchMode;
  agentId?: string;
  provider?: 'claude' | 'codex' | 'gemini' | 'antigravity' | 'copilot' | 'cursor' | 'grok' | 'auto';
  model?: string;
  /** Omitted = spawn path applies the app-level per-provider default. */
  reasoningEffort?: ReasoningEffort | null;
  modelRuntimeTarget?: ModelRuntimeTarget;
  bareMode?: boolean;
  /** Explicit fast-mode override; when omitted, resolved from per-provider memory. */
  fastMode?: boolean;
  forceNodeId?: string;
  /** WS9 per-instance browser tool surface; omitted = global setting decides. */
  browserToolsMode?: 'eager' | 'deferred' | 'off';
  /** WS13 — spawn the CLI inside the macOS Seatbelt jail. */
  hardened?: boolean;
  /** Explicit GitHub Copilot account for this session (validated safe slug). */
  copilotAccountProfileId?: string;
  /** The user confirmed an override that leaves a protected Copilot scope. */
  copilotConfirmProtectedOverride?: boolean;
}

// ============================================
// File Handling Constants
// ============================================

export const FILE_LIMITS = {
  MAX_IMAGE_SIZE: 5 * 1024 * 1024,     // 5MB for images (API hard limit)
  MAX_FILE_SIZE: 30 * 1024 * 1024,      // 30MB for other files (API limit)
  MAX_IMAGE_DIMENSION: 8000,            // Maximum dimension for images
  /**
   * Hard ceiling on attachments in a single IPC payload. Must stay in step with
   * `.max(10)` on `InstanceCreateWithMessagePayloadSchema.attachments` and
   * `InstanceSendInputPayloadSchema.attachments` in
   * `packages/contracts/src/schemas/instance.schemas.ts` — the main process
   * rejects the whole payload past this count, so the renderer has to refuse
   * first and say why. Both sides are pinned by tests.
   */
  MAX_ATTACHMENTS: 10,
} as const;
