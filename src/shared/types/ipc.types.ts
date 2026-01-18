/**
 * IPC Types - Inter-Process Communication between Main and Renderer
 */

import type { ContextUsage, FileAttachment, InstanceStatus, OutputMessage } from './instance.types';

/**
 * IPC Channel names - domain:action pattern
 */
export const IPC_CHANNELS = {
  // Instance management
  INSTANCE_CREATE: 'instance:create',
  INSTANCE_TERMINATE: 'instance:terminate',
  INSTANCE_TERMINATE_ALL: 'instance:terminate-all',
  INSTANCE_RESTART: 'instance:restart',
  INSTANCE_RENAME: 'instance:rename',
  INSTANCE_SEND_INPUT: 'instance:send-input',
  INSTANCE_STATE_UPDATE: 'instance:state-update',
  INSTANCE_OUTPUT: 'instance:output',
  INSTANCE_BATCH_UPDATE: 'instance:batch-update',
  INSTANCE_CREATED: 'instance:created',
  INSTANCE_REMOVED: 'instance:removed',
  INSTANCE_LIST: 'instance:list',

  // Cross-instance communication
  COMM_REQUEST_TOKEN: 'comm:request-token',
  COMM_SEND_MESSAGE: 'comm:send-message',
  COMM_SUBSCRIBE: 'comm:subscribe',
  COMM_CONTROL: 'comm:control-instance',
  COMM_CREATE_BRIDGE: 'comm:create-bridge',

  // Supervisor operations
  SUPERVISOR_STATUS: 'supervisor:status',
  SUPERVISOR_METRICS: 'supervisor:metrics',

  // File operations
  FILE_DROP: 'file:drop',
  IMAGE_PASTE: 'image:paste',

  // App operations
  APP_READY: 'app:ready',
  APP_GET_VERSION: 'app:get-version',

  // CLI detection
  CLI_DETECT_ALL: 'cli:detect-all',
  CLI_CHECK: 'cli:check',

  // Dialog operations
  DIALOG_SELECT_FOLDER: 'dialog:select-folder',

  // Settings operations
  SETTINGS_GET_ALL: 'settings:get-all',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_UPDATE: 'settings:update',
  SETTINGS_RESET: 'settings:reset',
  SETTINGS_RESET_ONE: 'settings:reset-one',
  SETTINGS_CHANGED: 'settings:changed',

  // Memory management
  MEMORY_GET_STATS: 'memory:get-stats',
  MEMORY_STATS_UPDATE: 'memory:stats-update',
  MEMORY_WARNING: 'memory:warning',
  MEMORY_CRITICAL: 'memory:critical',
  MEMORY_LOAD_HISTORY: 'memory:load-history',
} as const;

export type IpcChannel = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS];

/**
 * Message envelope for all IPC communication
 */
export interface IpcMessage<T = unknown> {
  id: string;
  channel: IpcChannel;
  timestamp: number;
  payload: T;
  replyChannel?: string;
}

// ============================================
// Instance Management Payloads
// ============================================

export interface InstanceCreatePayload {
  workingDirectory: string;
  sessionId?: string;
  parentInstanceId?: string;
  displayName?: string;
  initialPrompt?: string;
  attachments?: FileAttachment[];
  yoloMode?: boolean;
}

export interface InstanceStateUpdatePayload {
  instanceId: string;
  status: InstanceStatus;
  contextUsage?: ContextUsage;
  error?: ErrorInfo;
}

export interface InstanceOutputPayload {
  instanceId: string;
  message: OutputMessage;
}

export interface BatchUpdatePayload {
  updates: InstanceStateUpdatePayload[];
  timestamp: number;
}

export interface InstanceSendInputPayload {
  instanceId: string;
  message: string;
  attachments?: FileAttachment[];
}

export interface InstanceTerminatePayload {
  instanceId: string;
  graceful?: boolean;
}

export interface InstanceRestartPayload {
  instanceId: string;
}

export interface InstanceRenamePayload {
  instanceId: string;
  displayName: string;
}

// ============================================
// Communication Payloads
// ============================================

export interface TokenRequestPayload {
  sourceInstanceId: string;
  targetInstanceId: string;
  permissions: ('read' | 'write' | 'control')[];
  ttlMs?: number;
}

export interface TokenResponsePayload {
  success: boolean;
  token?: string;
  error?: string;
}

export interface CrossInstanceMessagePayload {
  fromInstanceId: string;
  toInstanceId: string;
  token: string;
  message: string;
  asInput?: boolean;
}

export interface ControlInstancePayload {
  fromInstanceId: string;
  toInstanceId: string;
  token: string;
  command: 'restart' | 'terminate' | 'pause';
}

export interface SubscribePayload {
  subscriberId: string;
  targetId: string;
  token: string;
}

export interface CreateBridgePayload {
  sourceId: string;
  targetId: string;
  token: string;
}

// ============================================
// Supervisor Payloads
// ============================================

export interface SupervisorMetrics {
  totalNodes: number;
  totalInstances: number;
  nodeMetrics: SupervisorNodeMetrics[];
}

export interface SupervisorNodeMetrics {
  nodeId: string;
  name: string;
  childCount: number;
  maxChildren: number;
  load: number;
  childSupervisorCount: number;
}

// ============================================
// Error Types
// ============================================

export interface ErrorInfo {
  code: string;
  message: string;
  stack?: string;
  timestamp: number;
}

// ============================================
// Settings Payloads
// ============================================

export interface SettingsSetPayload {
  key: string;
  value: unknown;
}

export interface SettingsUpdatePayload {
  settings: Record<string, unknown>;
}

export interface SettingsResetOnePayload {
  key: string;
}

export interface SettingsChangedPayload {
  key: string;
  value: unknown;
}

// ============================================
// Memory Management Payloads
// ============================================

export interface MemoryStatsPayload {
  process: {
    heapUsedMB: number;
    heapTotalMB: number;
    externalMB: number;
    rssMB: number;
    percentUsed: number;
  };
  storage: {
    totalInstances: number;
    totalMessages: number;
    totalSizeMB: number;
    maxSizeMB: number;
  };
  pressureLevel: 'normal' | 'warning' | 'critical';
}

export interface MemoryWarningPayload {
  heapUsedMB: number;
  heapTotalMB: number;
  message: string;
}

export interface LoadHistoryPayload {
  instanceId: string;
  limit?: number;
}

// ============================================
// Response Types
// ============================================

export interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ErrorInfo;
}
