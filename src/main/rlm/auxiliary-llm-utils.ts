import type { AuxiliaryLlmEndpointConfig, AuxiliaryLlmSlotConfig } from '../../shared/types/auxiliary-llm.types';
import { DEFAULT_SLOT_TIERS } from '../../shared/types/auxiliary-llm.types';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';

// DEFAULT_SLOT_TIERS lives in shared so the settings migration, renderer, and
// router all agree on the per-slot defaults. Re-exported here for callers that
// already import tier helpers from this module.
export { DEFAULT_SLOT_TIERS } from '../../shared/types/auxiliary-llm.types';

/**
 * Whether an endpoint can serve `model`. True when it advertises the id. When
 * the model list is empty we only trust the pin for NON-worker endpoints — a
 * worker node's list comes from its heartbeat and is authoritative, so an empty
 * list there means the model genuinely isn't available; a manual endpoint's list
 * may be a transient probe failure, so we honour the user's explicit pin.
 */
export function endpointAdvertisesModel(source: string, model: string, ids: string[]): boolean {
  if (ids.includes(model)) return true;
  return ids.length === 0 && source !== 'worker-node';
}

/**
 * Backfill the default `tier` into any slot of a persisted `auxiliaryLlmSlotsJson`
 * that lacks one. Returns the updated JSON string, or null when nothing changed
 * or the input is unparseable (caller leaves the stored value untouched). Pure —
 * unit-tested in lieu of an electron-store-bound settings-manager harness.
 */
export function backfillSlotTiers(raw: string): string | null {
  let slots: Record<string, { tier?: string } | undefined>;
  try {
    slots = JSON.parse(raw) as Record<string, { tier?: string } | undefined>;
  } catch {
    return null;
  }
  let changed = false;
  for (const [name, defaultTier] of Object.entries(DEFAULT_SLOT_TIERS)) {
    const slot = slots[name];
    if (slot && slot.tier === undefined) {
      slot.tier = defaultTier;
      changed = true;
    }
  }
  return changed ? JSON.stringify(slots) : null;
}

/**
 * Raise a slot's `maxOutputTokens` up to `minTokens` if it's currently lower.
 * Reasoning models spend their budget on hidden reasoning before emitting any
 * content, so a too-small budget (e.g. titleGeneration's old 128) leaves the
 * actual answer empty. Returns updated JSON, or null when unchanged/unparseable.
 */
export function raiseSlotOutputBudget(raw: string, slot: string, minTokens: number): string | null {
  let slots: Record<string, { maxOutputTokens?: number } | undefined>;
  try {
    slots = JSON.parse(raw) as Record<string, { maxOutputTokens?: number } | undefined>;
  } catch {
    return null;
  }
  const cfg = slots[slot];
  if (!cfg || typeof cfg.maxOutputTokens !== 'number' || cfg.maxOutputTokens >= minTokens) {
    return null;
  }
  cfg.maxOutputTokens = minTokens;
  return JSON.stringify(slots);
}

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
  tier: 'quick' | 'quality' | undefined,
  quickModel: string,
  qualityModel: string,
): string | undefined {
  if (slotConfig.model) return slotConfig.model;
  if (tier === 'quick' && quickModel) return quickModel;
  if (tier === 'quality' && qualityModel) return qualityModel;
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
 * Map of model id → loaded context length for a worker endpoint's currently
 * resident models, from the heartbeat. Empty when the worker doesn't report
 * load state (older worker, or a server without load-state visibility).
 */
export function workerLoadedContexts(
  nodes: WorkerNodeInfo[],
  workerNodeId: string | undefined,
  provider: string,
  baseUrl: string,
): Map<string, number> {
  const map = new Map<string, number>();
  if (!workerNodeId) return map;
  for (const node of nodes) {
    if (node.id !== workerNodeId) continue;
    for (const cap of node.capabilities.localModelEndpoints ?? []) {
      if (cap.provider === provider && cap.baseUrl === baseUrl) {
        for (const lm of cap.loadedModels ?? []) map.set(lm.id, lm.contextLength);
      }
    }
  }
  return map;
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
 * explicit/tier model is configured. Embedding models are skipped.
 *
 * When `loaded` (id → resident context length) is supplied and any candidate is
 * loaded, the pick is restricted to loaded models — avoiding a JIT-load of a
 * larger model at a tiny default context that would overflow on big inputs.
 * Among loaded models: `quality` (large inputs) → largest context, then largest
 * size; `quick` (latency-sensitive) → smallest size. With no loaded info it
 * falls back to size only: `quick` → smallest, `quality` → largest.
 */
export function pickModelForTier(
  modelIds: string[],
  tier?: 'quick' | 'quality',
  loaded?: ReadonlyMap<string, number>,
): string | undefined {
  if (modelIds.length === 0) return undefined;
  const chat = modelIds.filter((id) => !/embed/i.test(id));
  const pool = chat.length > 0 ? chat : modelIds;

  if (loaded && loaded.size > 0) {
    const loadedPool = pool.filter((id) => loaded.has(id));
    if (loadedPool.length > 0) {
      if (tier === 'quality') {
        return loadedPool.reduce((a, b) =>
          loaded.get(b)! > loaded.get(a)!
          || (loaded.get(b)! === loaded.get(a)! && modelSizeScore(b) > modelSizeScore(a)) ? b : a);
      }
      if (tier === 'quick') {
        return loadedPool.reduce((a, b) => (modelSizeScore(b) < modelSizeScore(a) ? b : a));
      }
      return loadedPool[0];
    }
  }

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
