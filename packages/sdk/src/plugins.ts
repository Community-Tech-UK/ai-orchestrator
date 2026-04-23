/**
 * Minimal message shape exposed to plugin authors.
 */
export interface OutputMessage {
  id: string;
  timestamp: number;
  type: 'assistant' | 'user' | 'system' | 'tool_use' | 'tool_result' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
  attachments?: {
    name: string;
    type: string;
    size: number;
    data: string;
  }[];
}

export type PluginRecord = Record<string, unknown>;

export type PluginSlot =
  | 'provider'
  | 'channel'
  | 'mcp'
  | 'skill'
  | 'hook'
  | 'tracker'
  | 'notifier'
  | 'telemetry_exporter';

export type PluginLoadPhase =
  | 'manifest_load'
  | 'manifest_validation'
  | 'instantiation'
  | 'detect'
  | 'slot_registration'
  | 'ready';

export type PluginPhaseStatus = 'pending' | 'succeeded' | 'failed' | 'skipped';

export interface PluginPhaseResult {
  phase: PluginLoadPhase;
  status: PluginPhaseStatus;
  timestamp: number;
  message?: string;
}

export interface PluginLoadReport {
  slot: PluginSlot;
  detected: boolean;
  ready: boolean;
  phases: PluginPhaseResult[];
  error?: string;
}

export interface PluginTrackerEvent {
  event: string;
  timestamp: number;
  instanceId?: string;
  data?: PluginRecord;
}

export interface PluginNotification {
  event: string;
  message: string;
  timestamp: number;
  title?: string;
  priority?: string;
  instanceId?: string;
  channels?: string[];
  data?: PluginRecord;
}

export interface PluginTelemetryRecord {
  event: string;
  timestamp: number;
  attributes?: PluginRecord;
  data?: PluginRecord;
}

export interface PluginHookPayloads {
  'instance.created': PluginRecord & {
    id: string;
    instanceId: string;
    workingDirectory: string;
    provider?: string;
  };
  'instance.removed': {
    instanceId: string;
  };
  'instance.output': {
    instanceId: string;
    message: OutputMessage;
  };
  'verification.started': PluginRecord & {
    id: string;
    verificationId: string;
    instanceId: string;
  };
  'verification.completed': PluginRecord & {
    id: string;
    verificationId: string;
    instanceId: string;
    fromCache?: boolean;
  };
  'verification.error': {
    request: PluginRecord & {
      id?: string;
      instanceId?: string;
    };
    error: unknown;
    verificationId: string;
    instanceId: string;
  };
  'instance.stateChanged': {
    instanceId: string;
    previousState: string;
    newState: string;
    timestamp: number;
  };
  'orchestration.debate.round': {
    debateId: string;
    round: number;
    totalRounds: number;
    participantId: string;
    response: string;
  };
  'orchestration.consensus.vote': {
    consensusId: string;
    voterId: string;
    vote: string;
    confidence: number;
  };
  'tool.execute.before': {
    instanceId: string;
    toolName: string;
    args: Record<string, unknown>;
    skip?: boolean;
  };
  'tool.execute.after': {
    instanceId: string;
    toolName: string;
    args: Record<string, unknown>;
    result: unknown;
    durationMs: number;
  };
  'session.created': {
    instanceId: string;
    sessionId: string;
  };
  'session.resumed': {
    instanceId: string;
    sessionId: string;
  };
  'session.compacting': {
    instanceId: string;
    messageCount: number;
    tokenCount: number;
  };
  'permission.ask': {
    instanceId: string;
    toolName: string;
    command?: string;
    decision?: 'allow' | 'deny' | undefined;
  };
  'config.loaded': {
    config: Record<string, unknown>;
  };
}

export type PluginHookEvent = keyof PluginHookPayloads;

export type OrchestratorHooks = {
  [K in PluginHookEvent]?: (
    payload: PluginHookPayloads[K],
  ) => void | Promise<void>;
};

export interface TrackerPlugin {
  track(event: PluginTrackerEvent): void | Promise<void>;
}

export interface NotifierPlugin {
  notify(notification: PluginNotification): void | Promise<void>;
}

export interface TelemetryExporterPlugin {
  export(record: PluginTelemetryRecord): void | Promise<void>;
}

export interface PluginRuntimeBySlot {
  provider: unknown;
  channel: unknown;
  mcp: unknown;
  skill: unknown;
  hook: OrchestratorHooks;
  tracker: TrackerPlugin;
  notifier: NotifierPlugin;
  telemetry_exporter: TelemetryExporterPlugin;
}

export type PluginRuntimeForSlot<S extends PluginSlot> = PluginRuntimeBySlot[S];

export interface SdkPluginContext {
  appPath: string;
  homeDir: string | null;
}

export interface PluginModuleDefinition<T = unknown> {
  hooks?: OrchestratorHooks;
  detect?: (
    ctx: SdkPluginContext,
  ) => boolean | Promise<boolean>;
  slot?: PluginSlot;
  create?: (
    ctx: SdkPluginContext,
  ) => T | Promise<T>;
}

export type SdkPluginModule =
  | OrchestratorHooks
  | PluginModuleDefinition
  | ((ctx: SdkPluginContext) => OrchestratorHooks | PluginModuleDefinition | Promise<OrchestratorHooks | PluginModuleDefinition>);

/** Manifest schema for plugin.json — validated on load */
export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  slot?: PluginSlot;
  hooks?: string[];
  config?: {
    schema: Record<string, unknown>; // JSON Schema for plugin config
  };
}
