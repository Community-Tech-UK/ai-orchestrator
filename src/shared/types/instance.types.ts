/**
 * Instance Types - Core data models for Claude Code instances
 */

import type { AgentMode } from './agent.types';

// ============================================
// Session Export Types
// ============================================

/**
 * Exported session format (JSON)
 */
export interface ExportedSession {
  version: string;           // Export format version
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
  atMessageIndex?: number;   // Fork at specific message, defaults to latest
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
  planContent?: string;     // The plan being reviewed
  approvedAt?: number;      // When the plan was approved
}

// ============================================
// Core Types
// ============================================

export type InstanceStatus =
  | 'initializing'
  | 'idle'
  | 'busy'
  | 'waiting_for_input'
  | 'error'
  | 'terminated';

export interface ContextUsage {
  used: number;
  total: number;
  percentage: number;
  costEstimate?: number;
}

export interface OutputMessage {
  id: string;
  timestamp: number;
  type: 'assistant' | 'user' | 'system' | 'tool_use' | 'tool_result' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
  /** File attachments for user messages */
  attachments?: FileAttachment[];
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

  // Hierarchy
  parentId: string | null;
  childrenIds: string[];
  supervisorNodeId: string;

  // Agent mode
  agentId: string;  // References AgentProfile.id ('build', 'plan', 'review', or custom)
  agentMode: AgentMode;

  // Plan mode state
  planMode: PlanModeConfig;

  // State
  status: InstanceStatus;
  contextUsage: ContextUsage;
  lastActivity: number;
  currentActivity?: string;  // Human-readable activity description
  currentTool?: string;       // Current tool being used

  // CLI process
  processId: number | null;
  sessionId: string;
  workingDirectory: string;
  yoloMode: boolean;  // Auto-approve all permissions

  // Output
  outputBuffer: OutputMessage[];
  outputBufferMaxSize: number;

  // Communication
  communicationTokens: Map<string, CommunicationToken>;
  subscribedTo: string[];

  // Metrics
  totalTokensUsed: number;
  requestCount: number;
  errorCount: number;
  restartCount: number;
}

export interface InstanceCreateConfig {
  displayName?: string;
  parentId?: string | null;
  sessionId?: string;
  resume?: boolean;  // Resume a previous session (requires sessionId)
  workingDirectory: string;
  initialPrompt?: string;
  attachments?: FileAttachment[];
  yoloMode?: boolean;
  initialOutputBuffer?: OutputMessage[];  // Pre-populate output buffer (for history restore)
  agentId?: string;  // Agent profile ID (defaults to 'build')
  modelOverride?: string;  // Optional model override for the instance
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
  // Import agent profile to get mode
  const { getAgentById, getDefaultAgent } = require('./agent.types');
  const agent = config.agentId ? getAgentById(config.agentId) : getDefaultAgent();
  const resolvedAgent = agent || getDefaultAgent();

  return {
    id: crypto.randomUUID(),
    displayName: config.displayName || `Instance ${now}`,
    createdAt: now,

    parentId: config.parentId || null,
    childrenIds: [],
    supervisorNodeId: '',

    agentId: resolvedAgent.id,
    agentMode: resolvedAgent.mode,

    planMode: {
      enabled: false,
      state: 'off',
    },

    status: 'initializing',
    contextUsage: { used: 0, total: 200000, percentage: 0 },
    lastActivity: now,

    processId: null,
    sessionId: config.sessionId || crypto.randomUUID(),
    workingDirectory: config.workingDirectory,
    yoloMode: config.yoloMode ?? true,  // Default to YOLO mode enabled

    outputBuffer: config.initialOutputBuffer || [],
    outputBufferMaxSize: 1000,

    communicationTokens: new Map(),
    subscribedTo: [],

    totalTokensUsed: 0,
    requestCount: 0,
    errorCount: 0,
    restartCount: 0,
  };
}

/**
 * Serialize instance for IPC (Maps to Objects)
 */
export function serializeInstance(instance: Instance): Record<string, unknown> {
  return {
    ...instance,
    communicationTokens: Object.fromEntries(instance.communicationTokens),
  };
}

/**
 * Deserialize instance from IPC (Objects to Maps)
 */
export function deserializeInstance(data: Record<string, unknown>): Instance {
  return {
    ...(data as unknown as Instance),
    communicationTokens: new Map(
      Object.entries(data['communicationTokens'] as Record<string, CommunicationToken> || {})
    ),
  };
}
