/**
 * Auxiliary LLM Service
 *
 * Routes low-risk helper calls (compression, memory distillation, title
 * generation, etc.) to local/cheap models (Ollama, OpenAI-compatible) while
 * reserving frontier models for main tool-using agents.
 *
 * Usage:
 *   getAuxiliaryLlmService().configure(settings);
 *   const { text, decision } = await getAuxiliaryLlmService().generate('compression', sys, user);
 */

import { EventEmitter } from 'events';
import type { AppSettings } from '../../shared/types/settings.types';
import { DEFAULT_SETTINGS } from '../../shared/types/settings.types';
import type {
  AuxiliaryLlmSlot,
  AuxiliaryLlmProvider,
  AuxiliaryLlmSlotConfig,
  AuxiliaryLlmSlotConfigMap,
  AuxiliaryLlmEndpointConfig,
  AuxiliaryLlmCandidate,
  AuxiliaryLlmDecision,
  AuxiliaryLlmModelInfo,
} from '../../shared/types/auxiliary-llm.types';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import {
  probeOllamaEndpoint,
  listOllamaModels,
  generateWithOllama,
  probeOpenAiCompatibleEndpoint,
  listOpenAiCompatibleModels,
  generateWithOpenAiCompatible,
} from './auxiliary-model-client';
import { getTokenCounter } from './token-counter';
import { getLogger } from '../logging/logger';
import { resolveAuxiliaryEndpointApiKey } from './auxiliary-api-key-resolver';
import { computeNumCtx, hostKeyFromUrl, localhostOllamaEndpoint, resolveSlotModel, pickModelForTier, workerEndpointHealthy, workerLoadedContexts, endpointAdvertisesModel, DEFAULT_SLOT_TIERS } from './auxiliary-llm-utils';
import { sanitizeProviderText } from '../security/surrogate-sanitizer';
// remote-node imports are lazy — worker-node-connection and service-rpc-client
// transitively import electron via remote-auth → settings-manager, which
// crashes in worker_thread contexts. We must NOT top-level-import them.
// See src/main/instance/__tests__/context-worker-import-isolation.spec.ts.

export { computeNumCtx } from './auxiliary-llm-utils';

const AUXILIARY_MODEL_GENERATE_METHOD = 'auxiliaryModel.generate';

// ─── Remote-node access seams ───────────────────────────────────────────────
// These are lazy-required (not top-level imported) because worker-node-connection
// and service-rpc-client transitively import electron via remote-auth →
// settings-manager, which crashes in worker_thread contexts. The indirection
// also gives tests an injection point (vitest cannot mock a native require()).
// See src/main/instance/__tests__/context-worker-import-isolation.spec.ts.

function defaultIsNodeConnected(nodeId: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getWorkerNodeConnectionServer } = require('../remote-node/worker-node-connection') as typeof import('../remote-node/worker-node-connection');
    return getWorkerNodeConnectionServer().isNodeConnected(nodeId);
  } catch {
    return false;
  }
}

async function defaultSendServiceRpc<T>(
  nodeId: string,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sendServiceRpc } = require('../remote-node/service-rpc-client') as typeof import('../remote-node/service-rpc-client');
  return sendServiceRpc<T>(nodeId, method, params, timeoutMs);
}

/**
 * Connected worker nodes (with their reported capabilities). Returns an empty
 * list if the registry cannot be loaded (e.g. worker context).
 */
function defaultConnectedWorkerNodes(): WorkerNodeInfo[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getWorkerNodeRegistry } = require('../remote-node/worker-node-registry') as typeof import('../remote-node/worker-node-registry');
    return getWorkerNodeRegistry().getAllNodes().filter((n) => n.status === 'connected');
  } catch {
    return [];
  }
}

let isNodeConnectedLazy = defaultIsNodeConnected;
let sendServiceRpcLazy: <T>(nodeId: string, method: string, params: unknown, timeoutMs: number) => Promise<T> =
  defaultSendServiceRpc;
let getConnectedWorkerNodesLazy = defaultConnectedWorkerNodes;

/** Test-only: override the remote-node access seams. */
export function __setAuxiliaryRemoteHooksForTesting(hooks: {
  isNodeConnected?: (nodeId: string) => boolean;
  sendServiceRpc?: <T>(nodeId: string, method: string, params: unknown, timeoutMs: number) => Promise<T>;
  connectedWorkerNodes?: () => WorkerNodeInfo[];
}): void {
  if (hooks.isNodeConnected) isNodeConnectedLazy = hooks.isNodeConnected;
  if (hooks.sendServiceRpc) sendServiceRpcLazy = hooks.sendServiceRpc;
  if (hooks.connectedWorkerNodes) getConnectedWorkerNodesLazy = hooks.connectedWorkerNodes;
}

/** Test-only: restore the production lazy-require seams. */
export function __resetAuxiliaryRemoteHooksForTesting(): void {
  isNodeConnectedLazy = defaultIsNodeConnected;
  sendServiceRpcLazy = defaultSendServiceRpc;
  getConnectedWorkerNodesLazy = defaultConnectedWorkerNodes;
}

const logger = getLogger('AuxiliaryLlmService');

// ─── Constants ────────────────────────────────────────────────────────────────

const HEALTH_CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;

const JSON_FALLBACK_TEXT =
  '{"score":0,"confidence":0,"reason":"No auxiliary model available"}';

/** Slots that return empty string (not JSON) on fallback. */
const EMPTY_FALLBACK_SLOTS = new Set<AuxiliaryLlmSlot>(['compression', 'memoryDistillation', 'retrievalHypothesis', 'verifyOutputSummary']);

// ─── Internal types ───────────────────────────────────────────────────────────

type AuxiliaryLlmConfigSubset = Pick<
  AppSettings,
  | 'auxiliaryLlmEnabled'
  | 'auxiliaryLlmRoutingMode'
  | 'auxiliaryLlmAllowRemoteWorkerModels'
  | 'auxiliaryLlmUseLocalhostOllama'
  | 'auxiliaryLlmEndpointsJson'
  | 'auxiliaryLlmSlotsJson'
  | 'auxiliaryLlmQuickModel'
  | 'auxiliaryLlmQualityModel'
>;

interface HealthCacheEntry {
  healthy: boolean;
  checkedAt: number;
}

// ─── Helper: parse default slots from DEFAULT_SETTINGS ────────────────────────

function parseDefaultSlots(): AuxiliaryLlmSlotConfigMap {
  try {
    return JSON.parse(DEFAULT_SETTINGS.auxiliaryLlmSlotsJson) as AuxiliaryLlmSlotConfigMap;
  } catch {
    // Should never happen — the default is a constant in this codebase.
    return {} as AuxiliaryLlmSlotConfigMap;
  }
}

export class AuxiliaryLlmService extends EventEmitter {
  private static instance: AuxiliaryLlmService | null = null;

  private enabled = true;
  private routingMode: AppSettings['auxiliaryLlmRoutingMode'] = 'local-first';
  private allowRemoteWorkerModels = true;
  private useLocalhostOllama = true;
  private endpoints: AuxiliaryLlmEndpointConfig[] = [];
  private slots: AuxiliaryLlmSlotConfigMap = parseDefaultSlots();
  private quickModel = '';
  private qualityModel = '';

  // endpointId → health cache entry
  private healthCache = new Map<string, HealthCacheEntry>();

  private constructor() {
    super();
  }

  static getInstance(): AuxiliaryLlmService {
    if (!AuxiliaryLlmService.instance) {
      AuxiliaryLlmService.instance = new AuxiliaryLlmService();
    }
    return AuxiliaryLlmService.instance;
  }

  static _resetForTesting(): void {
    AuxiliaryLlmService.instance = null;
  }

  // ─── Configuration ─────────────────────────────────────────────────────────

  configure(settings: AuxiliaryLlmConfigSubset): void {
    this.enabled = settings.auxiliaryLlmEnabled;
    this.routingMode = settings.auxiliaryLlmRoutingMode;
    this.allowRemoteWorkerModels = settings.auxiliaryLlmAllowRemoteWorkerModels;
    this.useLocalhostOllama = settings.auxiliaryLlmUseLocalhostOllama;
    this.quickModel = settings.auxiliaryLlmQuickModel?.trim() ?? '';
    this.qualityModel = settings.auxiliaryLlmQualityModel?.trim() ?? '';

    // Parse endpoints
    try {
      this.endpoints = JSON.parse(settings.auxiliaryLlmEndpointsJson) as AuxiliaryLlmEndpointConfig[];
    } catch {
      logger.warn('auxiliaryLlmEndpointsJson is invalid JSON; using empty endpoints list');
      this.endpoints = [];
    }

    // Parse slots, merging missing ones with defaults
    const defaults = parseDefaultSlots();
    let parsedSlots: Partial<AuxiliaryLlmSlotConfigMap>;
    try {
      parsedSlots = JSON.parse(settings.auxiliaryLlmSlotsJson) as Partial<AuxiliaryLlmSlotConfigMap>;
    } catch {
      logger.warn('auxiliaryLlmSlotsJson is invalid JSON; using defaults for all slots');
      parsedSlots = {};
    }
    this.slots = { ...defaults, ...parsedSlots } as AuxiliaryLlmSlotConfigMap;

    // Invalidate health cache when config changes
    this.healthCache.clear();
    logger.info('AuxiliaryLlmService configured', {
      enabled: this.enabled,
      routingMode: this.routingMode,
      endpointCount: this.endpoints.length,
    });
  }

  // ─── Discovery ─────────────────────────────────────────────────────────────

  async discoverCandidates(): Promise<AuxiliaryLlmCandidate[]> {
    const candidates: AuxiliaryLlmCandidate[] = [];

    // Probe the coordinator's localhost Ollama unless it has been excluded from
    // auxiliary routing (auxiliaryLlmUseLocalhostOllama = false).
    const localOllama = localhostOllamaEndpoint(this.useLocalhostOllama);
    if (localOllama) {
      candidates.push(await this.probeCandidate(localOllama));
    }

    // Probe all configured endpoints
    const endpointsToProbe = this.endpoints.filter(
      (ep) => ep.enabled && (this.allowRemoteWorkerModels || ep.source !== 'worker-node')
    );
    for (const endpoint of endpointsToProbe) {
      candidates.push(await this.probeCandidate(endpoint));
    }

    // Surface local models reported by connected worker nodes. This data comes
    // from the heartbeat — we never dial the worker's 127.0.0.1 directly;
    // generation is proxied through the worker-agent RPC channel.
    const persistedIds = new Set(this.endpoints.map((ep) => ep.id));
    for (const wc of this.workerNodeEndpoints()) {
      if (persistedIds.has(wc.endpoint.id)) continue; // avoid duplicating a persisted entry
      candidates.push({
        endpoint: wc.endpoint,
        models: wc.models,
        healthy: wc.healthy,
        reason: wc.healthy
          ? wc.models.length === 0
            ? 'No models reported'
            : undefined
          : 'Worker Ollama unhealthy',
      });
    }

    return candidates;
  }

  // ─── Generation ────────────────────────────────────────────────────────────

  async generate(
    slot: AuxiliaryLlmSlot,
    systemPrompt: string,
    userPrompt: string
  ): Promise<{ text: string; decision: AuxiliaryLlmDecision }> {
    // Service disabled / routing off → behave normally (allow frontier fallback).
    if (!this.enabled || this.routingMode === 'off') {
      return this.buildFallback(slot, 'Service disabled or routing mode is off', true);
    }

    const slotConfig = this.slots[slot];
    if (!slotConfig?.enabled) {
      // Slot explicitly turned off → normal (frontier-allowed) behavior.
      return this.buildFallback(slot, 'Slot is disabled', true);
    }

    const truncated = this.maybeTruncatePrompt(slot, slotConfig, systemPrompt, userPrompt);
    const resolved = await this.resolveEndpointForSlot(slot, slotConfig);
    if (!resolved) {
      // Enabled but nothing healthy found — honor the slot's frontier-fallback policy.
      return this.buildFallback(slot, 'No healthy auxiliary endpoint/model available', slotConfig.allowFrontierFallback);
    }

    const { endpoint, model } = resolved;

    // Worker-node localhost models count as local; only manual remote APIs are cheap-cloud.
    const source: AuxiliaryLlmDecision['source'] =
      endpoint.source === 'localhost' ||
      endpoint.source === 'worker-node' ||
      endpoint.provider === 'ollama'
        ? 'local'
        : 'cheap-cloud';

    // Actually call the model
    try {
      const text = await this.callEndpoint(endpoint, model, slotConfig, truncated.system, truncated.user);
      const decision: AuxiliaryLlmDecision = {
        slot,
        provider: endpoint.provider as AuxiliaryLlmProvider,
        endpointId: endpoint.id,
        model,
        source,
        reason: `Routed via ${this.routingMode} to ${endpoint.label}`,
        allowFrontierFallback: slotConfig.allowFrontierFallback,
      };
      return { text, decision };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Auxiliary generation failed for slot "${slot}": ${message}`);
      return this.buildFallback(slot, `Generation error: ${message}`, slotConfig.allowFrontierFallback);
    }
  }

  // ─── Private: endpoint resolution ──────────────────────────────────────────

  private async resolveEndpointForSlot(
    slot: AuxiliaryLlmSlot,
    slotConfig: AuxiliaryLlmSlotConfig
  ): Promise<{ endpoint: AuxiliaryLlmEndpointConfig; model: string } | null> {
    // Explicit endpointId + model first — but validate the endpoint offers it.
    if (slotConfig.endpointId && slotConfig.model) {
      const ep = this.endpoints.find((e) => e.id === slotConfig.endpointId && e.enabled);
      if (ep && (await this.isEndpointHealthy(ep))) {
        const ids = (await this.listModels(ep)).map((m) => m.id);
        if (endpointAdvertisesModel(ep.source, slotConfig.model, ids)) {
          return { endpoint: ep, model: slotConfig.model };
        }
      }
    }

    if (this.routingMode === 'manual-only') {
      // Explicit config was required; nothing else to try
      return null;
    }

    if (this.routingMode === 'local-first') {
      return this.resolveLocalFirst(slot, slotConfig);
    }

    if (this.routingMode === 'cheap-first') {
      return this.resolveCheapFirst(slot, slotConfig);
    }

    return null;
  }

  private async resolveLocalFirst(
    slot: AuxiliaryLlmSlot,
    slotConfig: AuxiliaryLlmSlotConfig
  ): Promise<{ endpoint: AuxiliaryLlmEndpointConfig; model: string } | null> {
    const localOllama = localhostOllamaEndpoint(this.useLocalhostOllama);
    const enabled = this.enabledEndpoints();
    // local-first defaults to the remote node machine for remote work: worker-node models first, this host's localhost as fallback, then the rest.
    const ordered = [
      ...enabled.filter((ep) => ep.source === 'worker-node'),
      ...this.autoWorkerEndpoints(),
      ...(localOllama ? [localOllama] : []),
      ...enabled.filter((ep) => ep.source !== 'worker-node'),
    ];

    for (const ep of ordered) {
      const result = await this.tryEndpointForSlot(ep, slot, slotConfig);
      if (result) return result;
    }
    return null;
  }

  private async resolveCheapFirst(
    slot: AuxiliaryLlmSlot,
    slotConfig: AuxiliaryLlmSlotConfig
  ): Promise<{ endpoint: AuxiliaryLlmEndpointConfig; model: string } | null> {
    const localOllama = localhostOllamaEndpoint(this.useLocalhostOllama);

    const configured = this.enabledEndpoints();
    const cheapCloud = configured.filter(
      (ep) => ep.source !== 'localhost' && ep.provider !== 'ollama'
    );
    const local = configured.filter(
      (ep) => ep.source === 'localhost' || ep.provider === 'ollama'
    );

    // Cheap-cloud (openai-compatible, non-localhost) first, then local, then
    // worker-local, then the coordinator's localhost Ollama (if enabled).
    const ordered = [
      ...cheapCloud,
      ...local,
      ...this.autoWorkerEndpoints(),
      ...(localOllama ? [localOllama] : []),
    ];
    for (const ep of ordered) {
      const result = await this.tryEndpointForSlot(ep, slot, slotConfig);
      if (result) return result;
    }
    return null;
  }

  private async tryEndpointForSlot(
    ep: AuxiliaryLlmEndpointConfig,
    slot: AuxiliaryLlmSlot,
    slotConfig: AuxiliaryLlmSlotConfig
  ): Promise<{ endpoint: AuxiliaryLlmEndpointConfig; model: string } | null> {
    const healthy = await this.isEndpointHealthy(ep);
    if (!healthy) return null;

    // Effective tier: explicit tier, or name-based default for legacy configs.
    const tier = slotConfig.tier ?? DEFAULT_SLOT_TIERS[slot];
    const ids = (await this.listModels(ep)).map((m) => m.id);
    const preferred = resolveSlotModel(slotConfig, tier, this.quickModel, this.qualityModel);
    // Use a pinned/tier model only if the endpoint advertises it (see helper for
    // the empty-list rule); otherwise auto-pick by tier from what's listed.
    if (preferred && endpointAdvertisesModel(ep.source, preferred, ids)) {
      return { endpoint: ep, model: preferred };
    }
    if (ids.length === 0) return null;
    // Prefer a model already loaded with adequate context (worker endpoints only).
    const loaded = ep.source === 'worker-node'
      ? workerLoadedContexts(getConnectedWorkerNodesLazy(), ep.workerNodeId, ep.provider, ep.baseUrl)
      : undefined;
    const picked = pickModelForTier(ids, tier, loaded);
    return picked ? { endpoint: ep, model: picked } : null;
  }

  // ─── Private: health cache ──────────────────────────────────────────────────

  private async isEndpointHealthy(ep: AuxiliaryLlmEndpointConfig): Promise<boolean> {
    const cached = this.healthCache.get(ep.id);
    if (cached && Date.now() - cached.checkedAt < HEALTH_CACHE_TTL_MS) {
      return cached.healthy;
    }

    let healthy: boolean;
    try {
      if (ep.source === 'worker-node') {
        // Healthy only when the node is connected AND its heartbeat reports the local model server up.
        healthy = !!ep.workerNodeId && isNodeConnectedLazy(ep.workerNodeId)
          && workerEndpointHealthy(getConnectedWorkerNodesLazy(), ep.workerNodeId, ep.provider, ep.baseUrl);
      } else if (ep.provider === 'ollama') {
        healthy = await probeOllamaEndpoint(ep.baseUrl, PROBE_TIMEOUT_MS);
      } else {
        const apiKey = await resolveAuxiliaryEndpointApiKey(ep);
        healthy = await probeOpenAiCompatibleEndpoint(ep.baseUrl, apiKey, PROBE_TIMEOUT_MS);
      }
    } catch {
      healthy = false;
    }

    this.healthCache.set(ep.id, { healthy, checkedAt: Date.now() });
    return healthy;
  }

  // ─── Private: model listing ─────────────────────────────────────────────────

  private async listModels(ep: AuxiliaryLlmEndpointConfig): Promise<AuxiliaryLlmModelInfo[]> {
    try {
      if (ep.source === 'worker-node') {
        // Never dial the worker's localhost — use the models reported on heartbeat.
        return this.workerNodeModels(ep);
      }
      if (ep.provider === 'ollama') {
        return await listOllamaModels(ep.baseUrl, PROBE_TIMEOUT_MS);
      }
      const apiKey = await resolveAuxiliaryEndpointApiKey(ep);
      return await listOpenAiCompatibleModels(ep.baseUrl, apiKey, PROBE_TIMEOUT_MS);
    } catch {
      return [];
    }
  }

  /** Models a connected worker reported for the given endpoint (no direct dial). */
  private workerNodeModels(ep: AuxiliaryLlmEndpointConfig): AuxiliaryLlmModelInfo[] {
    if (!ep.workerNodeId) return [];
    for (const node of getConnectedWorkerNodesLazy()) {
      if (node.id !== ep.workerNodeId) continue;
      for (const cap of node.capabilities.localModelEndpoints ?? []) {
        if (cap.provider === ep.provider && cap.baseUrl === ep.baseUrl) {
          return cap.models.map<AuxiliaryLlmModelInfo>((m) => ({
            id: m,
            name: m,
            provider: cap.provider,
            endpointId: ep.id,
          }));
        }
      }
    }
    return [];
  }

  // ─── Private: actual HTTP call ──────────────────────────────────────────────

  private async callEndpoint(
    ep: AuxiliaryLlmEndpointConfig,
    model: string,
    slotConfig: AuxiliaryLlmSlotConfig,
    systemPrompt: string,
    userPrompt: string
  ): Promise<string> {
    // OpenAI-compatible servers ignore numCtx; Ollama uses it to avoid clipping long prompts.
    const tokenCounter = getTokenCounter();
    const promptTokens = tokenCounter.countTokens(systemPrompt) + tokenCounter.countTokens(userPrompt);
    const numCtx = computeNumCtx(promptTokens, slotConfig.maxOutputTokens, slotConfig.maxInputTokens);
    const safePrompts = sanitizeProviderText({ systemPrompt, userPrompt });

    // Proxy worker-node endpoints; the coordinator must not dial worker localhost directly.
    if (ep.source === 'worker-node') {
      if (!ep.workerNodeId) {
        throw new Error('Worker-node endpoint missing workerNodeId');
      }
      const result = await sendServiceRpcLazy<{ text: string }>(
        ep.workerNodeId,
        AUXILIARY_MODEL_GENERATE_METHOD,
        {
          provider: ep.provider,
          model,
          systemPrompt: safePrompts.systemPrompt, userPrompt: safePrompts.userPrompt,
          temperature: slotConfig.temperature,
          maxOutputTokens: slotConfig.maxOutputTokens,
          timeoutMs: slotConfig.timeoutMs,
          requireJson: slotConfig.requireJson,
          numCtx,
        },
        slotConfig.timeoutMs + 1000,
      );
      return result.text;
    }

    const req = {
      systemPrompt: safePrompts.systemPrompt, userPrompt: safePrompts.userPrompt,
      model,
      temperature: slotConfig.temperature,
      maxOutputTokens: slotConfig.maxOutputTokens,
      timeoutMs: slotConfig.timeoutMs,
      requireJson: slotConfig.requireJson,
      numCtx,
    };

    if (ep.provider === 'ollama') {
      return generateWithOllama(ep.baseUrl, req);
    }

    const apiKey = await resolveAuxiliaryEndpointApiKey(ep);
    return generateWithOpenAiCompatible(ep.baseUrl, apiKey, req);
  }

  // ─── Private: prompt truncation ─────────────────────────────────────────────

  private maybeTruncatePrompt(
    slot: AuxiliaryLlmSlot,
    slotConfig: AuxiliaryLlmSlotConfig,
    systemPrompt: string,
    userPrompt: string
  ): { system: string; user: string } {
    const tokenCounter = getTokenCounter();
    const systemTokens = tokenCounter.countTokens(systemPrompt);
    const userTokens = tokenCounter.countTokens(userPrompt);
    const totalTokens = systemTokens + userTokens;

    if (totalTokens <= slotConfig.maxInputTokens) {
      return { system: systemPrompt, user: userPrompt };
    }

    // Budget remaining tokens for userPrompt after system prompt
    const targetTokens = Math.max(0, slotConfig.maxInputTokens - systemTokens);

    // Preserve first 20% and last 40% of userPrompt chars
    const userChars = userPrompt.length;
    const keepFirst = Math.floor(userChars * 0.2);
    const keepLast = Math.floor(userChars * 0.4);
    const truncatedUser =
      userPrompt.slice(0, keepFirst) +
      '\n[...truncated...]\n' +
      userPrompt.slice(userChars - keepLast);

    this.emit('auxiliary:input-truncated', {
      slot,
      originalTokens: totalTokens,
      targetTokens,
    });

    logger.warn(`Auxiliary prompt truncated for slot "${slot}"`, {
      originalTokens: totalTokens,
      targetTokens,
    });

    return { system: systemPrompt, user: truncatedUser };
  }

  // ─── Private: fallback builder ──────────────────────────────────────────────

  private buildFallback(
    slot: AuxiliaryLlmSlot,
    reason: string,
    allowFrontierFallback: boolean
  ): { text: string; decision: AuxiliaryLlmDecision } {
    const text = EMPTY_FALLBACK_SLOTS.has(slot) ? '' : JSON_FALLBACK_TEXT;
    const decision: AuxiliaryLlmDecision = {
      slot,
      provider: 'local-fallback',
      source: 'fallback',
      reason,
      allowFrontierFallback,
    };
    return { text, decision };
  }

  // ─── Private: utility ───────────────────────────────────────────────────────

  private enabledEndpoints(): AuxiliaryLlmEndpointConfig[] {
    return this.endpoints.filter(
      (ep) =>
        ep.enabled &&
        (this.allowRemoteWorkerModels || ep.source !== 'worker-node')
    );
  }

  /**
   * Build auxiliary endpoint configs (with reported models + health) from the
   * local models advertised by connected worker nodes. Gated by
   * allowRemoteWorkerModels. The baseUrl is worker-local and is NEVER dialed
   * directly by the coordinator — listing and generation for these endpoints go
   * through the worker-agent RPC channel.
   */
  private workerNodeEndpoints(): {
    endpoint: AuxiliaryLlmEndpointConfig;
    models: AuxiliaryLlmModelInfo[];
    healthy: boolean;
  }[] {
    if (!this.allowRemoteWorkerModels) return [];

    const result: {
      endpoint: AuxiliaryLlmEndpointConfig;
      models: AuxiliaryLlmModelInfo[];
      healthy: boolean;
    }[] = [];
    for (const node of getConnectedWorkerNodesLazy()) {
      for (const cap of node.capabilities.localModelEndpoints ?? []) {
        // Include host:port so a node advertising two endpoints of the same
        // provider (e.g. two Ollama instances on different ports) yields
        // distinct ids instead of one silently overwriting the other.
        const hostKey = hostKeyFromUrl(cap.baseUrl);
        const endpoint: AuxiliaryLlmEndpointConfig = {
          id: `worker:${node.id}:${cap.provider}:${hostKey}`,
          label: `${node.name} · ${cap.provider}`,
          provider: cap.provider,
          baseUrl: cap.baseUrl,
          source: 'worker-node',
          workerNodeId: node.id,
          enabled: true,
        };
        const models = cap.models.map<AuxiliaryLlmModelInfo>((m) => ({
          id: m,
          name: m,
          provider: cap.provider,
          endpointId: endpoint.id,
        }));
        result.push({ endpoint, models, healthy: cap.healthy });
      }
    }
    return result;
  }

  /** Auto-discovered worker endpoints that are not already persisted in config. */
  private autoWorkerEndpoints(): AuxiliaryLlmEndpointConfig[] {
    const persistedIds = new Set(this.endpoints.map((e) => e.id));
    return this.workerNodeEndpoints()
      .map((w) => w.endpoint)
      .filter((e) => !persistedIds.has(e.id));
  }

  // ─── Private: candidate probing (for discoverCandidates) ───────────────────

  private async probeCandidate(ep: AuxiliaryLlmEndpointConfig): Promise<AuxiliaryLlmCandidate> {
    const healthy = await this.isEndpointHealthy(ep);
    let models: AuxiliaryLlmModelInfo[] = [];
    let reason: string | undefined;

    if (healthy) {
      models = await this.listModels(ep);
      if (models.length === 0) {
        reason = 'No models available';
      }
    } else {
      reason = 'Endpoint unreachable';
    }

    return { endpoint: ep, models, healthy, reason };
  }
}

// ─── Singleton accessor ───────────────────────────────────────────────────────

export function getAuxiliaryLlmService(): AuxiliaryLlmService {
  return AuxiliaryLlmService.getInstance();
}
