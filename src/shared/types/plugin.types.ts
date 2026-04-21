/**
 * Typed plugin hook payloads for the Orchestrator plugin system.
 *
 * These payloads preserve the current runtime shapes exposed by
 * `OrchestratorPluginManager` while adding a few normalized aliases
 * where the source events are inconsistent.
 */

import type { OutputMessage } from './instance.types';

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
  | 'hook_registration'
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

export type TypedOrchestratorHooks = {
  [K in PluginHookEvent]?: (
    payload: PluginHookPayloads[K],
  ) => void | Promise<void>;
};
