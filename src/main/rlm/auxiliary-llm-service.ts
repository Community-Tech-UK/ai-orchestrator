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
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types/settings.types';
import {
  AUXILIARY_DISCOVERY_DEADLINE_MS,
  AUXILIARY_DISCOVERY_MAX_CANDIDATES,
  type AuxiliaryLlmCandidate,
  type AuxiliaryLlmDecision,
  type AuxiliaryLlmEndpointConfig,
  type AuxiliaryLlmModelInfo,
  type AuxiliaryLlmProvider,
  type AuxiliaryLlmSlot,
  type AuxiliaryLlmSlotConfig,
  type AuxiliaryLlmSlotConfigMap,
} from '../../shared/types/auxiliary-llm.types';
import { auxiliaryRemoteHooks } from './auxiliary-remote-hooks';
import {
  listOllamaModels,
  generateWithOllama,
  listOpenAiCompatibleModels,
  generateWithOpenAiCompatible,
} from './auxiliary-model-client';
import { getTokenCounter } from './token-counter';
import { getLogger } from '../logging/logger';
import { retryAuxiliaryGeneration } from './auxiliary-generation-retry';
import { AuxiliaryDailySpendCap } from './auxiliary-daily-spend-cap';
import { resolveAuxiliaryEndpointApiKey } from './auxiliary-api-key-resolver';
import { AuxiliaryModelFailureCache, computeNumCtx, localhostOllamaEndpoint, resolveSlotModel, pickModelForTier, workerLoadedContexts, endpointAdvertisesModel, DEFAULT_SLOT_TIERS } from './auxiliary-llm-utils';
import { sanitizeProviderText } from '../security/surrogate-sanitizer';
import {
  buildAuthorizedAuxiliaryFallback,
  classifyAuxiliarySource,
  describeAuxiliaryResolutionFailure,
  recordAuxiliaryIneligibility,
  evaluateManagedAuxiliaryEndpoint,
  invalidateManagedAuxiliaryTarget,
  managedAuxiliaryModelsAvailable,
  recordSuccessfulAuxiliary,
  requireAuxiliaryText,
  runWithLocalAiTargetLease,
  type LocalAiResolutionContext,
  type ResolvedAuxiliaryEndpoint,
} from './auxiliary-local-ai-guard';
import {
  AuxiliaryEndpointHealthCache,
  AuxiliaryResolutionWarningThrottle,
  listAuxiliaryModelsForRouting,
} from './auxiliary-routing-diagnostics';
import {
  auxiliaryWorkerSourceKeys,
  collectAuxiliaryWorkerEndpointConfigs,
  collectAuxiliaryWorkerEndpoints,
  resolveAuxiliaryWorkerModels,
  settleBeforeAbort,
} from './auxiliary-discovery';
// remote-node imports are lazy — worker-node-connection and service-rpc-client
// transitively import electron via remote-auth → settings-manager, which
// crashes in worker_thread contexts. We must NOT top-level-import them.
// See src/main/instance/__tests__/context-worker-import-isolation.spec.ts.
export { computeNumCtx } from './auxiliary-llm-utils';
// Re-exported so existing test imports through this module keep working.
export {
  __setAuxiliaryRemoteHooksForTesting,
  __resetAuxiliaryRemoteHooksForTesting,
} from './auxiliary-remote-hooks';
const AUXILIARY_MODEL_GENERATE_METHOD = 'auxiliaryModel.generate';
const logger = getLogger('AuxiliaryLlmService');
// ─── Constants ────────────────────────────────────────────────────────────────
const PROBE_TIMEOUT_MS = 5_000;

type AuxiliaryLlmConfigSubset = Pick<
  AppSettings,
  | 'auxiliaryLlmEnabled'
  | 'auxiliaryLlmRoutingMode'
  | 'auxiliaryLlmAllowRemoteWorkerModels'
  | 'auxiliaryLlmUseLocalhostOllama'
  | 'auxiliaryLlmDailySpendCapUsd'
  | 'auxiliaryLlmEndpointsJson'
  | 'auxiliaryLlmSlotsJson'
  | 'auxiliaryLlmQuickModel'
  | 'auxiliaryLlmQualityModel'
>;

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
  private readonly dailySpendCap = new AuxiliaryDailySpendCap();

  private readonly endpointHealth = new AuxiliaryEndpointHealthCache();

  // Auto-picked models that recently failed, so the next pick steps down.
  private readonly modelFailures = new AuxiliaryModelFailureCache();

  // Keeps routing failures visible in the log without flooding it.
  private readonly resolutionWarnings = new AuxiliaryResolutionWarningThrottle();

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
    this.dailySpendCap.configure(settings.auxiliaryLlmDailySpendCapUsd);
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
    this.endpointHealth.clear();
    this.modelFailures.clear();
    logger.info('AuxiliaryLlmService configured', {
      enabled: this.enabled,
      routingMode: this.routingMode,
      endpointCount: this.endpoints.length,
    });
  }

  // ─── Discovery ─────────────────────────────────────────────────────────────

  async discoverCandidates(): Promise<AuxiliaryLlmCandidate[]> {
    const candidates: AuxiliaryLlmCandidate[] = [];
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(),
      AUXILIARY_DISCOVERY_DEADLINE_MS,
    );
    const appendProbe = async (endpoint: AuxiliaryLlmEndpointConfig): Promise<void> => {
      if (controller.signal.aborted || candidates.length >= AUXILIARY_DISCOVERY_MAX_CANDIDATES) return;
      const candidate = await settleBeforeAbort(
        this.probeCandidate(endpoint, controller.signal),
        controller.signal,
      );
      if (candidate && !controller.signal.aborted) candidates.push(candidate);
    };
    try {
      const localOllama = localhostOllamaEndpoint(this.useLocalhostOllama);
      if (localOllama) await appendProbe(localOllama);
      for (const endpoint of this.endpoints) {
        if (controller.signal.aborted || candidates.length >= AUXILIARY_DISCOVERY_MAX_CANDIDATES) break;
        if (endpoint.enabled && (this.allowRemoteWorkerModels || endpoint.source !== 'worker-node')) {
          await appendProbe(endpoint);
        }
      }
      const persistedWorkerSources = auxiliaryWorkerSourceKeys(this.endpoints);
      const remaining = AUXILIARY_DISCOVERY_MAX_CANDIDATES - candidates.length;
      if (controller.signal.aborted || remaining <= 0) return candidates;
      const workers = this.allowRemoteWorkerModels
        ? collectAuxiliaryWorkerEndpoints(
            auxiliaryRemoteHooks.connectedWorkerNodes(),
            remaining,
            persistedWorkerSources,
          )
        : [];
      for (const worker of workers) {
        if (controller.signal.aborted || candidates.length >= AUXILIARY_DISCOVERY_MAX_CANDIDATES) break;
        candidates.push({
          endpoint: worker.endpoint,
          models: worker.models,
          healthy: worker.healthy,
          reason: worker.healthy
            ? worker.models.length === 0 ? 'No models reported' : undefined
            : 'Worker Ollama unhealthy',
        });
      }
      return candidates;
    } finally {
      clearTimeout(deadline);
      controller.abort();
    }
  }

  // ─── Generation ────────────────────────────────────────────────────────────

  async generate(
    slot: AuxiliaryLlmSlot,
    systemPrompt: string,
    userPrompt: string
  ): Promise<{ text: string; decision: AuxiliaryLlmDecision }> {
    const fallback = (
      reason: string,
      slotAllowsFrontier: boolean,
      prompts = { system: systemPrompt, user: userPrompt },
      intendedTargetId?: string,
      estimatedOutputTokens = 0,
    ) => buildAuthorizedAuxiliaryFallback({
      slot, reason, slotAllowsFrontier, intendedTargetId, estimatedOutputTokens,
      systemPrompt: prompts.system, userPrompt: prompts.user,
    });
    if (!this.enabled || this.routingMode === 'off') {
      return fallback('Service disabled or routing mode is off', true);
    }

    const slotConfig = this.slots[slot];
    if (!slotConfig?.enabled) {
      return fallback('Slot is disabled', true);
    }

    const truncated = this.maybeTruncatePrompt(slot, slotConfig, systemPrompt, userPrompt);
    const localAiContext: LocalAiResolutionContext = {};
    const resolved = await this.resolveEndpointForSlot(slot, slotConfig, localAiContext);
    if (!resolved) {
      const detail = describeAuxiliaryResolutionFailure(localAiContext);
      this.resolutionWarnings.warn(slot, detail);
      return fallback(detail,
        slotConfig.allowFrontierFallback, truncated,
        localAiContext.intendedTargetId, slotConfig.maxOutputTokens);
    }

    const { endpoint, model, intendedTargetId, autoPicked } = resolved;

    const source = classifyAuxiliarySource(endpoint, intendedTargetId);

    const spendCapReason = this.dailySpendCap.reserve({
      slot,
      provider: endpoint.provider,
      endpointId: endpoint.id,
      model,
      maxOutputTokens: slotConfig.maxOutputTokens,
      systemPrompt: truncated.system,
      userPrompt: truncated.user,
      source,
    });
    if (spendCapReason) {
      return fallback(spendCapReason, false, truncated,
        intendedTargetId, slotConfig.maxOutputTokens);
    }

    try {
      const text = await runWithLocalAiTargetLease(
        intendedTargetId,
        async () => requireAuxiliaryText(
          await this.callEndpoint(endpoint, model, slotConfig, truncated.system, truncated.user),
        ),
      );
      const decision: AuxiliaryLlmDecision = {
        slot,
        provider: endpoint.provider as AuxiliaryLlmProvider,
        endpointId: endpoint.id,
        model,
        source,
        reason: `Routed via ${this.routingMode} to ${endpoint.label}`,
        allowFrontierFallback: slotConfig.allowFrontierFallback,
        ...(intendedTargetId ? { intendedTargetId } : {}),
      };
      recordSuccessfulAuxiliary({
        slot, endpoint, model, source, text, reason: decision.reason,
        systemPrompt: truncated.system, userPrompt: truncated.user,
      });
      return { text, decision };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Only auto-picked models are remembered. A pinned model must keep
      // surfacing its own error, and must not poison the auto-pick that another
      // slot on the same endpoint would otherwise make.
      if (autoPicked) this.modelFailures.record(endpoint.id, model);
      logger.warn(`Auxiliary generation failed for slot "${slot}": ${message}`);
      return fallback(`Generation error: ${message}`,
        slotConfig.allowFrontierFallback, truncated,
        intendedTargetId, slotConfig.maxOutputTokens);
    }
  }

  // ─── Private: endpoint resolution ──────────────────────────────────────────

  private async resolveEndpointForSlot(
    slot: AuxiliaryLlmSlot,
    slotConfig: AuxiliaryLlmSlotConfig,
    localAiContext: LocalAiResolutionContext,
  ): Promise<ResolvedAuxiliaryEndpoint | null> {
    // Explicit endpointId + model first — but validate the endpoint offers it.
    if (slotConfig.endpointId && slotConfig.model) {
      const ep = this.endpoints.find((e) => e.id === slotConfig.endpointId && e.enabled);
      const managedTarget = ep
        ? await evaluateManagedAuxiliaryEndpoint(ep, slot, localAiContext)
        : undefined;
      if (ep && managedTarget !== null) {
        // A managed target's fresh scheduler verdict is authoritative. Worker
        // heartbeat capability data is only a discovery hint and can lag it.
        const healthy = managedTarget ? true : await this.endpointHealth.isHealthy(ep);
        if (!healthy) {
          recordAuxiliaryIneligibility(localAiContext, ep.id, 'endpoint-heartbeat-unhealthy');
          invalidateManagedAuxiliaryTarget(managedTarget);
          return null;
        }
        // Same probe-failure rule as the auto-routing path below: an unknown
        // inventory is reported distinctly from an empty one, but still
        // invalidates the target.
        const inventory = await listAuxiliaryModelsForRouting(ep, managedTarget !== undefined);
        if (inventory.probeFailed) {
          recordAuxiliaryIneligibility(localAiContext, ep.id, 'model-inventory-probe-failed');
          invalidateManagedAuxiliaryTarget(managedTarget);
          return null;
        }
        const ids = inventory.ids;
        if (!managedAuxiliaryModelsAvailable(managedTarget, ids)) {
          recordAuxiliaryIneligibility(localAiContext, ep.id, 'required-models-missing');
          return null;
        }
        if (endpointAdvertisesModel(ep.source, slotConfig.model, ids)) {
          return {
            endpoint: ep,
            model: slotConfig.model,
            ...(managedTarget ? { intendedTargetId: managedTarget.targetId } : {}),
          };
        }
        recordAuxiliaryIneligibility(
          localAiContext, ep.id, `pinned-model-not-advertised-${slotConfig.model}`,
        );
        invalidateManagedAuxiliaryTarget(managedTarget);
      }
    }

    if (this.routingMode === 'manual-only') {
      // Explicit config was required; nothing else to try
      return null;
    }

    if (this.routingMode === 'local-first') {
      return this.resolveLocalFirst(slot, slotConfig, localAiContext);
    }

    if (this.routingMode === 'cheap-first') {
      return this.resolveCheapFirst(slot, slotConfig, localAiContext);
    }

    return null;
  }

  private async resolveLocalFirst(
    slot: AuxiliaryLlmSlot,
    slotConfig: AuxiliaryLlmSlotConfig,
    localAiContext: LocalAiResolutionContext,
  ): Promise<ResolvedAuxiliaryEndpoint | null> {
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
      const result = await this.tryEndpointForSlot(ep, slot, slotConfig, localAiContext);
      if (result) return result;
    }
    return null;
  }

  private async resolveCheapFirst(
    slot: AuxiliaryLlmSlot,
    slotConfig: AuxiliaryLlmSlotConfig,
    localAiContext: LocalAiResolutionContext,
  ): Promise<ResolvedAuxiliaryEndpoint | null> {
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
      const result = await this.tryEndpointForSlot(ep, slot, slotConfig, localAiContext);
      if (result) return result;
    }
    return null;
  }

  private async tryEndpointForSlot(
    ep: AuxiliaryLlmEndpointConfig,
    slot: AuxiliaryLlmSlot,
    slotConfig: AuxiliaryLlmSlotConfig,
    localAiContext: LocalAiResolutionContext,
  ): Promise<ResolvedAuxiliaryEndpoint | null> {
    const managedTarget = await evaluateManagedAuxiliaryEndpoint(ep, slot, localAiContext);
    if (managedTarget === null) return null;
    // Enrolled targets just passed the authoritative health engine. Do not
    // veto that result with the worker's shorter, independently timed
    // heartbeat probe; refresh the model inventory over RPC below instead.
    const healthy = managedTarget ? true : await this.endpointHealth.isHealthy(ep);
    if (!healthy) {
      recordAuxiliaryIneligibility(localAiContext, ep.id, 'endpoint-heartbeat-unhealthy');
      invalidateManagedAuxiliaryTarget(managedTarget);
      return null;
    }

    // Effective tier: explicit tier, or name-based default for legacy configs.
    const tier = slotConfig.tier ?? DEFAULT_SLOT_TIERS[slot];
    const inventory = await listAuxiliaryModelsForRouting(ep, managedTarget !== undefined);
    if (inventory.probeFailed) {
      // A failed probe means the inventory is UNKNOWN, not empty — worth saying
      // so in the fallback reason, because "endpoint advertises no models" sends
      // the next reader somewhere quite different from "the RPC timed out".
      //
      // The target is still invalidated, deliberately: a listing that throws is
      // itself evidence the endpoint may be unwell, and re-verifying its health
      // is the established contract here (see the `local-ai-auxiliary-integration`
      // spec). Only the *reason* is new.
      recordAuxiliaryIneligibility(localAiContext, ep.id, 'model-inventory-probe-failed');
      invalidateManagedAuxiliaryTarget(managedTarget);
      return null;
    }
    const ids = inventory.ids;
    if (!managedAuxiliaryModelsAvailable(managedTarget, ids)) {
      recordAuxiliaryIneligibility(localAiContext, ep.id, 'required-models-missing');
      return null;
    }
    const preferred = resolveSlotModel(slotConfig, tier, this.quickModel, this.qualityModel);
    // Use a pinned/tier model only if the endpoint advertises it (see helper for
    // the empty-list rule); otherwise auto-pick by tier from what's listed.
    if (preferred && endpointAdvertisesModel(ep.source, preferred, ids)) {
      return {
        endpoint: ep,
        model: preferred,
        ...(managedTarget ? { intendedTargetId: managedTarget.targetId } : {}),
      };
    }
    if (ids.length === 0) {
      recordAuxiliaryIneligibility(localAiContext, ep.id, 'endpoint-advertises-no-models');
      return null;
    }
    // Prefer a model already loaded with adequate context (worker endpoints only).
    const loaded = ep.source === 'worker-node'
      ? workerLoadedContexts(auxiliaryRemoteHooks.connectedWorkerNodes(), ep.workerNodeId, ep.provider, ep.baseUrl)
      : undefined;
    const picked = pickModelForTier(this.modelFailures.usable(ep.id, ids), tier, loaded);
    if (!picked) recordAuxiliaryIneligibility(localAiContext, ep.id, `no-model-for-tier-${tier}`);
    return picked
      ? {
          endpoint: ep,
          model: picked,
          autoPicked: true,
          ...(managedTarget ? { intendedTargetId: managedTarget.targetId } : {}),
        }
      : null;
  }

  // ─── Private: health cache ──────────────────────────────────────────────────

  // ─── Private: model listing ─────────────────────────────────────────────────

  private async listModels(
    ep: AuxiliaryLlmEndpointConfig,
    signal?: AbortSignal,
    refreshManagedWorker = false,
  ): Promise<AuxiliaryLlmModelInfo[]> {
    if (signal?.aborted) return [];
    try {
      if (ep.source === 'worker-node') {
        return resolveAuxiliaryWorkerModels(ep, refreshManagedWorker, PROBE_TIMEOUT_MS);
      }
      if (ep.provider === 'ollama') {
        return signal
          ? await listOllamaModels(ep.baseUrl, PROBE_TIMEOUT_MS, signal)
          : await listOllamaModels(ep.baseUrl, PROBE_TIMEOUT_MS);
      }
      const apiKey = await resolveAuxiliaryEndpointApiKey(ep);
      if (signal?.aborted) return [];
      return signal
        ? await listOpenAiCompatibleModels(ep.baseUrl, apiKey, PROBE_TIMEOUT_MS, signal)
        : await listOpenAiCompatibleModels(ep.baseUrl, apiKey, PROBE_TIMEOUT_MS);
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
    return retryAuxiliaryGeneration(
      () => this.callEndpointOnce(ep, model, slotConfig, systemPrompt, userPrompt),
      { endpointId: ep.id, provider: ep.provider },
    );
  }

  private async callEndpointOnce(
    ep: AuxiliaryLlmEndpointConfig,
    model: string,
    slotConfig: AuxiliaryLlmSlotConfig,
    systemPrompt: string,
    userPrompt: string,
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
      const result = await auxiliaryRemoteHooks.sendServiceRpc<{ text: string }>(
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

  // ─── Private: utility ───────────────────────────────────────────────────────

  private enabledEndpoints(): AuxiliaryLlmEndpointConfig[] {
    return this.endpoints.filter(
      (ep) =>
        ep.enabled &&
        (this.allowRemoteWorkerModels || ep.source !== 'worker-node')
    );
  }

  /** Auto-discovered worker endpoints that are not already persisted in config. */
  private autoWorkerEndpoints(): AuxiliaryLlmEndpointConfig[] {
    return collectAuxiliaryWorkerEndpointConfigs(
      auxiliaryRemoteHooks.connectedWorkerNodes(),
      AUXILIARY_DISCOVERY_MAX_CANDIDATES,
      auxiliaryWorkerSourceKeys(this.endpoints),
    );
  }

  // ─── Private: candidate probing (for discoverCandidates) ───────────────────

  private async probeCandidate(
    ep: AuxiliaryLlmEndpointConfig,
    signal: AbortSignal,
  ): Promise<AuxiliaryLlmCandidate | undefined> {
    const healthy = await this.endpointHealth.isHealthy(ep, signal);
    if (signal.aborted) return undefined;
    let models: AuxiliaryLlmModelInfo[] = [];
    let reason: string | undefined;

    if (healthy) {
      models = await this.listModels(ep, signal);
      if (signal.aborted) return undefined;
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
