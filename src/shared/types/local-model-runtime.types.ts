import type { CanonicalCliType } from './settings.types';

export type LocalModelEndpointProvider = 'ollama' | 'openai-compatible';
export type LocalModelSource = 'this-device' | 'worker-node';
export type LocalModelSelectorId = string;

export interface LocalModelLoadedModel {
  id: string;
  contextLength: number;
}

export interface LocalModelInventoryEntry {
  selectorId: LocalModelSelectorId;
  source: LocalModelSource;
  endpointProvider: LocalModelEndpointProvider;
  endpointId: string;
  modelId: string;
  displayName: string;
  nodeId?: string;
  nodeName?: string;
  platform?: string;
  healthy: boolean;
  loaded: boolean;
  loadedContextLength?: number;
  advertisedContextLength?: number;
  capabilities: {
    streaming: boolean;
    multiTurn: boolean;
    toolUse: 'none' | 'probable' | 'verified';
    vision: 'unknown' | 'no' | 'yes';
  };
  discoveredAt: number;
}

export type ModelRuntimeTarget =
  | { kind: 'cli'; provider?: CanonicalCliType }
  | {
      kind: 'local-model';
      source: LocalModelSource;
      endpointProvider: LocalModelEndpointProvider;
      endpointId: string;
      modelId: string;
      selectorId: LocalModelSelectorId;
      nodeId?: string;
      nodeName?: string;
    };

export interface InstanceRuntimeSummary {
  kind: 'cli' | 'local-model';
  label: string;
  source?: LocalModelSource;
  nodeId?: string;
  nodeName?: string;
  endpointProvider?: LocalModelEndpointProvider;
  endpointId?: string;
  modelId?: string;
  selectorId?: LocalModelSelectorId;
}
