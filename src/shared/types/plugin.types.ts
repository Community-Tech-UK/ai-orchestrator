/**
 * Typed plugin hook payloads for the Orchestrator plugin system.
 *
 * These payloads preserve the current runtime shapes exposed by
 * `OrchestratorPluginManager` while adding a few normalized aliases
 * where the source events are inconsistent.
 */

import type { OutputMessage } from './instance.types';

export type PluginRecord = Record<string, unknown>;

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
}

export type PluginHookEvent = keyof PluginHookPayloads;

export type TypedOrchestratorHooks = {
  [K in PluginHookEvent]?: (
    payload: PluginHookPayloads[K],
  ) => void | Promise<void>;
};
