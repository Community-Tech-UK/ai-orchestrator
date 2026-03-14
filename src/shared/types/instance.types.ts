/**
 * Instance Types - Core data models for AI CLI instances
 */

import { getAgentById, getDefaultAgent, type AgentMode } from './agent.types';
import type { CanonicalCliType } from './settings.types';
import type {
  TerminationPolicy,
  ContextInheritanceConfig,
} from './supervision.types';
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
  | 'waiting_for_input'
  | 'respawning'      // Instance is recovering from interrupt, cannot be interrupted again
  | 'hibernating'     // Saving state to disk before suspend
  | 'hibernated'      // State saved, process killed, can wake
  | 'waking'          // Restoring from hibernation
  | 'error'
  | 'failed'          // Unrecoverable init/wake failure
  | 'terminated';

export interface ContextUsage {
  used: number;
  total: number;
  percentage: number;
  costEstimate?: number;
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
  /** File attachments for user messages */
  attachments?: FileAttachment[];
  /** Extracted thinking/reasoning content */
  thinking?: ThinkingContent[];
  /** Whether thinking has been extracted from this message */
  thinkingExtracted?: boolean;
}

export interface FileAttachment {
  name: string;
  type: string;
  size: number;
  data: string; // base64 encoded
}

export interface CommunicationToken {
  token: string;
  targetInstanceId: string;
  permissions: ('read' | 'write' | 'control')[];
  expiresAt: number;
  createdBy: string;
}

export interface Instance {
  // Identity
  id: string;
  displayName: string;
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
  currentActivity?: string; // Human-readable activity description
  currentTool?: string; // Current tool being used

  // CLI process
  processId: number | null;
  sessionId: string;
  workingDirectory: string;
  yoloMode: boolean; // Auto-approve all permissions
  provider: InstanceProvider; // Which CLI provider is being used
  currentModel?: string; // Current model override (e.g., 'gpt-5.3-codex')

  // Output
  outputBuffer: OutputMessage[];
  outputBufferMaxSize: number;

  // Communication
  communicationTokens: Map<string, CommunicationToken>;
  subscribedTo: string[];

  // Lifecycle promises (not serialized)
  /** Resolves when init/wake completes. sendInput() awaits this. */
  readyPromise?: Promise<void>;
  /** Signals cancellation of in-progress init/wake. */
  abortController?: AbortController;

  // Metrics
  totalTokensUsed: number;
  requestCount: number;
  errorCount: number;
  restartCount: number;
}

export interface InstanceCreateConfig {
  displayName?: string;
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
    sessionId,
    workingDirectory: config.workingDirectory,
    yoloMode: config.yoloMode ?? false, // Default to YOLO mode disabled
    provider, // Default to auto (resolved by instance manager)

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
