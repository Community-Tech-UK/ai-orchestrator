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
// remote-node imports are lazy — worker-node-connection and service-rpc-client
// transitively import electron via remote-auth → settings-manager, which
// crashes in worker_thread contexts. We must NOT top-level-import them.
// See src/main/instance/__tests__/context-worker-import-isolation.spec.ts.

const AUXILIARY_MODEL_GENERATE_METHOD = 'auxiliaryModel.generate';

function isNodeConnectedLazy(nodeId: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getWorkerNodeConnectionServer } = require('../remote-node/worker-node-connection') as typeof import('../remote-node/worker-node-connection');
    return getWorkerNodeConnectionServer().isNodeConnected(nodeId);
  } catch {
    return false;
  }
}

async function sendServiceRpcLazy<T>(
  nodeId: string,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sendServiceRpc } = require('../remote-node/service-rpc-client') as typeof import('../remote-node/service-rpc-client');
  return sendServiceRpc<T>(nodeId, method, params, timeoutMs);
}

const logger = getLogger('AuxiliaryLlmService');

// ─── Constants ────────────────────────────────────────────────────────────────

const HEALTH_CACHE_TTL_MS = 60_000;
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const PROBE_TIMEOUT_MS = 5_000;

const JSON_FALLBACK_TEXT =
  '{"score":0,"confidence":0,"reason":"No auxiliary model available"}';

/** Slots that return empty string (not JSON) on fallback. */
const EMPTY_FALLBACK_SLOTS = new Set<AuxiliaryLlmSlot>(['compression', 'memoryDistillation']);

// ─── Internal types ───────────────────────────────────────────────────────────

type AuxiliaryLlmConfigSubset = Pick<
  AppSettings,
  | 'auxiliaryLlmEnabled'
  | 'auxiliaryLlmRoutingMode'
  | 'auxiliaryLlmAllowRemoteWorkerModels'
  | 'auxiliaryLlmEndpointsJson'
  | 'auxiliaryLlmSlotsJson'
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

// ─── Service ──────────────────────────────────────────────────────────────────

export class AuxiliaryLlmService extends EventEmitter {
  private static instance: AuxiliaryLlmService | null = null;

  private enabled = true;
  private routingMode: AppSettings['auxiliaryLlmRoutingMode'] = 'local-first';
  private allowRemoteWorkerModels = true;
  private endpoints: AuxiliaryLlmEndpointConfig[] = [];
  private slots: AuxiliaryLlmSlotConfigMap = parseDefaultSlots();

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

    // Always probe Ollama localhost
    const localOllama: AuxiliaryLlmEndpointConfig = {
      id: 'ollama-localhost',
      label: 'Ollama (localhost)',
      provider: 'ollama',
      baseUrl: DEFAULT_OLLAMA_URL,
      source: 'localhost',
      enabled: true,
    };
    candidates.push(await this.probeCandidate(localOllama));

    // Probe all configured endpoints
    const endpointsToProbe = this.endpoints.filter(
      (ep) => ep.enabled && (this.allowRemoteWorkerModels || ep.source !== 'worker-node')
    );
    for (const endpoint of endpointsToProbe) {
      candidates.push(await this.probeCandidate(endpoint));
    }

    return candidates;
  }

  // ─── Generation ────────────────────────────────────────────────────────────

  async generate(
    slot: AuxiliaryLlmSlot,
    systemPrompt: string,
    userPrompt: string
  ): Promise<{ text: string; decision: AuxiliaryLlmDecision }> {
    // Check service-level disabled / routing-mode off
    if (!this.enabled || this.routingMode === 'off') {
      return this.buildFallback(slot, 'Service disabled or routing mode is off');
    }

    const slotConfig = this.slots[slot];
    if (!slotConfig?.enabled) {
      return this.buildFallback(slot, 'Slot is disabled');
    }

    // Truncate prompt if needed
    const truncated = this.maybeTruncatePrompt(slot, slotConfig, systemPrompt, userPrompt);

    // Resolve endpoint + model according to routing mode
    const resolved = await this.resolveEndpointForSlot(slot, slotConfig);
    if (!resolved) {
      return this.buildFallback(slot, 'No healthy auxiliary endpoint/model available');
    }

    const { endpoint, model } = resolved;

    // Determine source category
    const source: AuxiliaryLlmDecision['source'] =
      endpoint.source === 'localhost' || endpoint.provider === 'ollama'
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
      };
      return { text, decision };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Auxiliary generation failed for slot "${slot}": ${message}`);
      return this.buildFallback(slot, `Generation error: ${message}`);
    }
  }

  // ─── Private: endpoint resolution ──────────────────────────────────────────

  private async resolveEndpointForSlot(
    slot: AuxiliaryLlmSlot,
    slotConfig: AuxiliaryLlmSlotConfig
  ): Promise<{ endpoint: AuxiliaryLlmEndpointConfig; model: string } | null> {
    // If the slot has an explicit endpointId + model, try that first
    if (slotConfig.endpointId && slotConfig.model) {
      const ep = this.endpoints.find((e) => e.id === slotConfig.endpointId && e.enabled);
      if (ep) {
        const healthy = await this.isEndpointHealthy(ep);
        if (healthy) {
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
    _slot: AuxiliaryLlmSlot,
    slotConfig: AuxiliaryLlmSlotConfig
  ): Promise<{ endpoint: AuxiliaryLlmEndpointConfig; model: string } | null> {
    // Build ordered list: localhost/ollama endpoints first, then others
    const localOllama: AuxiliaryLlmEndpointConfig = {
      id: 'ollama-localhost',
      label: 'Ollama (localhost)',
      provider: 'ollama',
      baseUrl: DEFAULT_OLLAMA_URL,
      source: 'localhost',
      enabled: true,
    };

    const ordered = [localOllama, ...this.enabledEndpoints()];

    for (const ep of ordered) {
      const result = await this.tryEndpointForSlot(ep, slotConfig);
      if (result) return result;
    }
    return null;
  }

  private async resolveCheapFirst(
    _slot: AuxiliaryLlmSlot,
    slotConfig: AuxiliaryLlmSlotConfig
  ): Promise<{ endpoint: AuxiliaryLlmEndpointConfig; model: string } | null> {
    // Cheap-cloud (openai-compatible, non-localhost) first, then local
    const localOllama: AuxiliaryLlmEndpointConfig = {
      id: 'ollama-localhost',
      label: 'Ollama (localhost)',
      provider: 'ollama',
      baseUrl: DEFAULT_OLLAMA_URL,
      source: 'localhost',
      enabled: true,
    };

    const configured = this.enabledEndpoints();
    const cheapCloud = configured.filter(
      (ep) => ep.source !== 'localhost' && ep.provider !== 'ollama'
    );
    const local = configured.filter(
      (ep) => ep.source === 'localhost' || ep.provider === 'ollama'
    );

    const ordered = [...cheapCloud, ...local, localOllama];
    for (const ep of ordered) {
      const result = await this.tryEndpointForSlot(ep, slotConfig);
      if (result) return result;
    }
    return null;
  }

  private async tryEndpointForSlot(
    ep: AuxiliaryLlmEndpointConfig,
    slotConfig: AuxiliaryLlmSlotConfig
  ): Promise<{ endpoint: AuxiliaryLlmEndpointConfig; model: string } | null> {
    const healthy = await this.isEndpointHealthy(ep);
    if (!healthy) return null;

    // If slot specifies a model, use it directly
    if (slotConfig.model) {
      return { endpoint: ep, model: slotConfig.model };
    }

    // Otherwise list models and pick the first available
    const models = await this.listModels(ep);
    if (models.length === 0) return null;
    return { endpoint: ep, model: models[0].id };
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
        // For worker-node endpoints the health check is a live WebSocket connection
        // check — we do not probe the worker's localhost URL directly.
        healthy = ep.workerNodeId ? isNodeConnectedLazy(ep.workerNodeId) : false;
      } else if (ep.provider === 'ollama') {
        healthy = await probeOllamaEndpoint(ep.baseUrl, PROBE_TIMEOUT_MS);
      } else {
        const apiKey = ep.apiKeyEnv ? process.env[ep.apiKeyEnv] : undefined;
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
      if (ep.provider === 'ollama') {
        return await listOllamaModels(ep.baseUrl, PROBE_TIMEOUT_MS);
      }
      const apiKey = ep.apiKeyEnv ? process.env[ep.apiKeyEnv] : undefined;
      return await listOpenAiCompatibleModels(ep.baseUrl, apiKey, PROBE_TIMEOUT_MS);
    } catch {
      return [];
    }
  }

  // ─── Private: actual HTTP call ──────────────────────────────────────────────

  private async callEndpoint(
    ep: AuxiliaryLlmEndpointConfig,
    model: string,
    slotConfig: AuxiliaryLlmSlotConfig,
    systemPrompt: string,
    userPrompt: string
  ): Promise<string> {
    // Worker-node endpoints: proxy the call via RPC so the coordinator never
    // connects to the worker's 127.0.0.1 directly.
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
          systemPrompt,
          userPrompt,
          temperature: slotConfig.temperature,
          maxOutputTokens: slotConfig.maxOutputTokens,
          timeoutMs: slotConfig.timeoutMs,
          requireJson: slotConfig.requireJson,
        },
        slotConfig.timeoutMs + 1000,
      );
      return result.text;
    }

    const req = {
      systemPrompt,
      userPrompt,
      model,
      temperature: slotConfig.temperature,
      maxOutputTokens: slotConfig.maxOutputTokens,
      timeoutMs: slotConfig.timeoutMs,
      requireJson: slotConfig.requireJson,
    };

    if (ep.provider === 'ollama') {
      return generateWithOllama(ep.baseUrl, req);
    }

    const apiKey = ep.apiKeyEnv ? process.env[ep.apiKeyEnv] : undefined;
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
    reason: string
  ): { text: string; decision: AuxiliaryLlmDecision } {
    const text = EMPTY_FALLBACK_SLOTS.has(slot) ? '' : JSON_FALLBACK_TEXT;
    const decision: AuxiliaryLlmDecision = {
      slot,
      provider: 'local-fallback',
      source: 'fallback',
      reason,
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
