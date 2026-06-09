import type { AuxiliaryLlmEndpointConfig, AuxiliaryLlmSlotConfig } from '../../shared/types/auxiliary-llm.types';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';

/** Default Ollama REST endpoint on the coordinator's own machine. */
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

/**
 * The coordinator's own localhost Ollama endpoint, or null when the user has
 * turned off `auxiliaryLlmUseLocalhostOllama` (e.g. to push all offload onto a
 * remote GPU worker without stopping the local Ollama that embeddings use).
 */
export function localhostOllamaEndpoint(useLocalhost: boolean): AuxiliaryLlmEndpointConfig | null {
  if (!useLocalhost) return null;
  return {
    id: 'ollama-localhost',
    label: 'Ollama (localhost)',
    provider: 'ollama',
    baseUrl: DEFAULT_OLLAMA_URL,
    source: 'localhost',
    enabled: true,
  };
}

// Ollama defaults num_ctx to a small value (~4k) and silently truncates longer
// prompts. We size the context window to fit the actual prompt + planned output
// so long-input slots aren't quietly chopped. Sizes are bucketed so the value is
// stable across similar calls; Ollama reloads the model whenever num_ctx changes.
const NUM_CTX_BUCKET = 8_192;
const NUM_CTX_MIN = 4_096;
const NUM_CTX_MAX_DEFAULT = 131_072;
const NUM_CTX_HEADROOM = 512;

/**
 * Pick an Ollama `num_ctx` that fits `promptTokens + outputTokens` plus template
 * headroom, rounded up to a stable bucket and clamped to sane bounds. The
 * ceiling is at least the slot's `maxInputTokens + outputTokens` budget so the
 * engine does not re-truncate prompts the slot was allowed to send.
 */
export function computeNumCtx(
  promptTokens: number,
  outputTokens: number,
  maxInputTokens: number,
): number {
  const desired = promptTokens + outputTokens + NUM_CTX_HEADROOM;
  const bucketed = Math.ceil(desired / NUM_CTX_BUCKET) * NUM_CTX_BUCKET;
  const ceiling = Math.max(NUM_CTX_MAX_DEFAULT, maxInputTokens + outputTokens + NUM_CTX_HEADROOM);
  return Math.min(Math.max(bucketed, NUM_CTX_MIN), ceiling);
}

/** Compact, stable `host:port` key for an endpoint URL (falls back to the raw value). */
export function hostKeyFromUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * The model id to use for a slot, in priority order:
 *   1. an explicit per-slot `model` pin (highest)
 *   2. the slot's tier model (`quick` → quickModel, `quality` → qualityModel)
 *   3. undefined → caller auto-picks the first available model
 */
export function resolveSlotModel(
  slotConfig: AuxiliaryLlmSlotConfig,
  quickModel: string,
  qualityModel: string,
): string | undefined {
  if (slotConfig.model) return slotConfig.model;
  if (slotConfig.tier === 'quick' && quickModel) return quickModel;
  if (slotConfig.tier === 'quality' && qualityModel) return qualityModel;
  return undefined;
}

/**
 * Whether a worker-node's reported local model endpoint is actually healthy —
 * i.e. the worker's heartbeat says its LM Studio / Ollama is up. The coordinator
 * must consult this (not just node connectivity) so that when no LLM is running
 * on the worker, the endpoint is skipped and routing falls back cleanly instead
 * of failing every generate call against a dead server.
 */
export function workerEndpointHealthy(
  nodes: WorkerNodeInfo[],
  workerNodeId: string | undefined,
  provider: string,
  baseUrl: string,
): boolean {
  if (!workerNodeId) return false;
  for (const node of nodes) {
    if (node.id !== workerNodeId) continue;
    for (const cap of node.capabilities.localModelEndpoints ?? []) {
      if (cap.provider === provider && cap.baseUrl === baseUrl) return cap.healthy;
    }
  }
  return false;
}

/**
 * Approximate parameter size for a model id, taken as the largest integer
 * immediately followed by `b`/`B` (e.g. `qwen3-35b-a3b` → 35, `nemotron-4b` →
 * 4). Ids with no such marker score 0. Used only to order tier auto-picks.
 */
export function modelSizeScore(modelId: string): number {
  let max = 0;
  const re = /(\d+(?:\.\d+)?)\s*b\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(modelId)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/**
 * Pick a model from a candidate list appropriate to a slot's tier when no
 * explicit/tier model is configured: `quick` → smallest by size score,
 * `quality` → largest. Embedding models are skipped (they can't chat). Falls
 * back to the first candidate when the tier is unset or no sizes are known.
 */
export function pickModelForTier(
  modelIds: string[],
  tier?: 'quick' | 'quality',
): string | undefined {
  if (modelIds.length === 0) return undefined;
  const chat = modelIds.filter((id) => !/embed/i.test(id));
  const pool = chat.length > 0 ? chat : modelIds;
  if (tier !== 'quick' && tier !== 'quality') return pool[0];

  const scored = pool.map((id) => ({ id, score: modelSizeScore(id) }));
  const known = scored.filter((s) => s.score > 0);
  if (known.length === 0) return pool[0];
  const winner =
    tier === 'quick'
      ? known.reduce((a, b) => (b.score < a.score ? b : a))
      : known.reduce((a, b) => (b.score > a.score ? b : a));
  return winner.id;
}
