/**
 * Auxiliary LLM Types
 *
 * Types for the auxiliary LLM routing layer that dispatches low-risk helper
 * calls (compression, memory distillation, title generation, etc.) to local
 * or cheap models while reserving frontier models for main tool-using agents.
 */

export type AuxiliaryLlmSlot =
  | 'compression'
  | 'memoryDistillation'
  | 'webExtract'
  | 'titleGeneration'
  | 'routingClassification'
  | 'approvalScoring'
  | 'loopScoring';

export type AuxiliaryLlmProvider =
  | 'ollama'
  | 'openai-compatible'
  | 'anthropic'
  | 'openai'
  | 'local-fallback';

export type AuxiliaryLlmRoutingMode = 'off' | 'local-first' | 'cheap-first' | 'manual-only';

export interface AuxiliaryLlmModelInfo {
  id: string;
  name: string;
  provider: AuxiliaryLlmProvider;
  endpointId: string;
  contextWindow?: number;
  parameterSize?: string;
  quantization?: string;
  modifiedAt?: string;
}

export interface AuxiliaryLlmEndpointConfig {
  id: string;
  label: string;
  provider: Exclude<AuxiliaryLlmProvider, 'local-fallback'>;
  baseUrl: string;
  apiKeyEnv?: string;
  source: 'manual' | 'localhost' | 'worker-node';
  workerNodeId?: string;
  enabled: boolean;
}

export interface AuxiliaryLlmSlotConfig {
  enabled: boolean;
  provider?: AuxiliaryLlmProvider | 'auto';
  endpointId?: string;
  model?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
  requireJson: boolean;
  allowFrontierFallback: boolean;
}

export type AuxiliaryLlmSlotConfigMap = Record<AuxiliaryLlmSlot, AuxiliaryLlmSlotConfig>;

export interface AuxiliaryLlmSettings {
  enabled: boolean;
  routingMode: AuxiliaryLlmRoutingMode;
  allowRemoteWorkerModels: boolean;
  endpoints: AuxiliaryLlmEndpointConfig[];
  slots: AuxiliaryLlmSlotConfigMap;
}

export interface AuxiliaryLlmCandidate {
  endpoint: AuxiliaryLlmEndpointConfig;
  models: AuxiliaryLlmModelInfo[];
  healthy: boolean;
  reason?: string;
}

export interface AuxiliaryLlmDecision {
  slot: AuxiliaryLlmSlot;
  provider: AuxiliaryLlmProvider;
  endpointId?: string;
  model?: string;
  source: 'local' | 'cheap-cloud' | 'fallback';
  reason: string;
}
