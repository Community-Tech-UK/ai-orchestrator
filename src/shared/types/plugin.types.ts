/**
 * Typed plugin hook payloads for the Orchestrator plugin system.
 *
 * These payloads preserve the current runtime shapes exposed by
 * `OrchestratorPluginManager` while adding a few normalized aliases
 * where the source events are inconsistent.
 */

import type { InstanceCreateConfig, OutputMessage } from './instance.types';
import type { AutomationDeliveryMode, AutomationTriggerSource } from './automation.types';

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

export interface PluginRoutingAudit {
  requestedProvider?: string;
  requestedModel?: string;
  actualProvider?: string;
  actualModel?: string;
  routingSource: 'explicit' | 'parent' | 'agent' | 'settings' | 'auto';
  reason?: string;
}

export interface PluginChildResultPayload {
  parentId: string;
  childId: string;
  name?: string;
  success?: boolean;
  summary?: string;
  resultId?: string;
  exitCode?: number | null;
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
  'instance.spawn.before': {
    instanceId?: string;
    parentId?: string | null;
    displayName?: string;
    workingDirectory: string;
    requestedProvider?: string;
    requestedModel?: string;
    agentId?: string;
    config: Partial<InstanceCreateConfig>;
    timestamp: number;
  };
  'instance.spawn.after': {
    instanceId: string;
    parentId: string | null;
    displayName: string;
    workingDirectory: string;
    requestedProvider?: string;
    requestedModel?: string;
    actualProvider?: string;
    actualModel?: string;
    agentId?: string;
    success: boolean;
    error?: string;
    timestamp: number;
  };
  'instance.input.before': {
    instanceId: string;
    messageLength: number;
    messagePreview: string;
    attachmentCount: number;
    isRetry?: boolean;
    autoContinuation?: boolean;
    timestamp: number;
  };
  'instance.input.after': {
    instanceId: string;
    messageLength: number;
    attachmentCount: number;
    success: boolean;
    error?: string;
    timestamp: number;
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
  'orchestration.command.received': {
    instanceId: string;
    action: string;
    command: Record<string, unknown>;
    timestamp: number;
  };
  'orchestration.command.completed': {
    instanceId: string;
    action: string;
    data?: unknown;
    timestamp: number;
  };
  'orchestration.command.failed': {
    instanceId: string;
    action: string;
    error?: string;
    data?: unknown;
    timestamp: number;
  };
  'orchestration.child.started': {
    parentId: string;
    childId: string;
    task: string;
    name?: string;
    routing?: PluginRoutingAudit;
    timestamp: number;
  };
  'orchestration.child.progress': {
    parentId: string;
    childId: string;
    percentage: number;
    currentStep: string;
    timestamp: number;
  };
  'orchestration.child.completed': PluginChildResultPayload & {
    timestamp: number;
  };
  'orchestration.child.failed': PluginChildResultPayload & {
    error?: string;
    timestamp: number;
  };
  'orchestration.child.result.reported': PluginChildResultPayload & {
    artifactCount?: number;
    timestamp: number;
  };
  'orchestration.consensus.started': {
    instanceId: string;
    question: string;
    providers?: string[];
    strategy?: string;
    timestamp: number;
  };
  'orchestration.consensus.completed': {
    instanceId: string;
    successCount: number;
    failureCount: number;
    totalDurationMs: number;
    timestamp: number;
  };
  'orchestration.consensus.failed': {
    instanceId: string;
    error: string;
    timestamp: number;
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
  'session.archived': {
    instanceId: string;
    historyThreadId?: string;
    providerSessionId?: string;
    messageCount: number;
    timestamp: number;
  };
  'session.terminated': {
    instanceId: string;
    parentId?: string | null;
    graceful: boolean;
    timestamp: number;
  };
  'automation.run.started': {
    automationId: string;
    runId: string;
    trigger: string;
    source?: AutomationTriggerSource;
    deliveryMode?: AutomationDeliveryMode;
    timestamp: number;
  };
  'automation.run.completed': {
    automationId: string;
    runId: string;
    status: string;
    outputSummary?: string;
    outputFullRef?: string;
    timestamp: number;
  };
  'automation.run.failed': {
    automationId: string;
    runId: string;
    status?: string;
    error?: string;
    outputFullRef?: string;
    timestamp: number;
  };
  'cleanup.candidate.before': {
    artifactId: string;
    path: string;
    reason: string;
    dryRun: boolean;
    timestamp: number;
  };
  'cleanup.candidate.after': {
    artifactId: string;
    path: string;
    reason: string;
    removed: boolean;
    error?: string;
    dryRun: boolean;
    timestamp: number;
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

export type TypedOrchestratorHooks = {
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
  hook: TypedOrchestratorHooks;
  tracker: TrackerPlugin;
  notifier: NotifierPlugin;
  telemetry_exporter: TelemetryExporterPlugin;
}

export type PluginRuntimeForSlot<S extends PluginSlot> = PluginRuntimeBySlot[S];
