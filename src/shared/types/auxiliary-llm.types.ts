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
  | 'loopScoring'
  | 'retrievalHypothesis'
  | 'branchScoring'
  | 'subQueryExecution'
  | 'verifyOutputSummary';

export type AuxiliaryLlmTier = 'quick' | 'quality';

/**
 * Default quality tier per slot. Single source of truth shared by the settings
 * migration (which backfills `tier` into persisted slot configs), the renderer
 * (to display the effective tier), and the router (runtime fallback for any slot
 * still missing a tier). Quick = small/fast (scoring, routing, titles);
 * quality = larger (compression, distillation, extraction).
 */
export const DEFAULT_SLOT_TIERS: Record<AuxiliaryLlmSlot, AuxiliaryLlmTier> = {
  compression: 'quality',
  memoryDistillation: 'quality',
  webExtract: 'quality',
  titleGeneration: 'quick',
  routingClassification: 'quick',
  approvalScoring: 'quick',
  loopScoring: 'quick',
  retrievalHypothesis: 'quick',
  branchScoring: 'quick',
  subQueryExecution: 'quality',
  verifyOutputSummary: 'quality',
};

export type AuxiliaryLlmProvider =
  | 'ollama'
  | 'openai-compatible'
  | 'anthropic'
  | 'openai'
  | 'local-fallback';

export type AuxiliaryLlmRoutingMode = 'off' | 'local-first' | 'cheap-first' | 'manual-only';

/**
 * Default Ollama `keep_alive` for auxiliary generation calls.
 *
 * Without this, Ollama unloads the model after ~5 minutes idle, so every helper
 * call after a lull pays the full cold load (e.g. ~17s to load a 20GB model into
 * VRAM) — which can exceed a slot's timeout. Keeping the model resident for 30
 * minutes means only the first call per session is cold. Applied by both the
 * direct client (`generateWithOllama`) and the worker-node RPC dispatcher.
 */
export const DEFAULT_OLLAMA_KEEP_ALIVE = '30m';

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
  /**
   * Trusted settings-only secret resolver. Accepts either a raw allowlisted
   * command string (for example `security find-generic-password ...`) or a
   * trusted resolver expression such as `${env:OPENAI_API_KEY}` /
   * `${file:/path/to/key}` / `${cmd:security ...}`. Resolved values are runtime
   * only and must never be persisted.
   */
  apiKeyCommand?: string;
  source: 'manual' | 'localhost' | 'worker-node';
  workerNodeId?: string;
  enabled: boolean;
}

export interface AuxiliaryLlmSlotConfig {
  enabled: boolean;
  provider?: AuxiliaryLlmProvider | 'auto';
  endpointId?: string;
  model?: string;
  /**
   * Quality tier for this slot. When set and no explicit `model` is pinned, the
   * router uses the tier's configured model (`auxiliaryLlmQuickModel` /
   * `auxiliaryLlmQualityModel`) — letting the user pick two models once (e.g. a
   * small fast model for scoring, a larger model for compression) instead of
   * assigning a model to every slot. An explicit `model` always wins.
   */
  tier?: 'quick' | 'quality';
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
  /**
   * Whether the caller may escalate to a frontier/cloud model when this result
   * is a fallback (i.e. no local/cheap model produced output). Mirrors the
   * slot's `allowFrontierFallback` setting. When `false`, callers must use a
   * deterministic local fallback instead of a frontier model — a hard "never
   * send this slot's content to the cloud" guarantee for privacy/cost. When the
   * auxiliary service is disabled or the slot is turned off, this is `true`
   * (the user is not relying on local routing, so normal behavior applies).
   */
  allowFrontierFallback: boolean;
}
