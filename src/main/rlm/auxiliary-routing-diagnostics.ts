/**
 * Auxiliary Routing Diagnostics
 *
 * Two small pieces that exist because auxiliary routing used to fail silently.
 * On 2026-09-07, 94% of every auxiliary decision (titles, compression, the lot)
 * fell back to "no local model" while the target's own health probes were green
 * all day, and nothing in the logs or the routing ledger said which gate closed.
 *
 * - {@link listAuxiliaryModelsForRouting} stops a failed inventory probe from
 *   masquerading as an endpoint that genuinely has no models.
 * - {@link AuxiliaryResolutionWarningThrottle} makes the fallback visible in the
 *   log without emitting hundreds of identical lines a day.
 */

import type {
  AuxiliaryLlmEndpointConfig,
  AuxiliaryLlmSlot,
} from '../../shared/types/auxiliary-llm.types';
import { getLogger } from '../logging/logger';
import { resolveAuxiliaryEndpointApiKey } from './auxiliary-api-key-resolver';
import { resolveAuxiliaryWorkerModels } from './auxiliary-discovery';
import {
  listOllamaModels,
  listOpenAiCompatibleModels,
  probeOllamaEndpoint,
  probeOpenAiCompatibleEndpoint,
} from './auxiliary-model-client';
import { auxiliaryRemoteHooks } from './auxiliary-remote-hooks';
import { workerEndpointHealthy } from './auxiliary-llm-utils';

const logger = getLogger('AuxiliaryRouting');

const PROBE_TIMEOUT_MS = 5_000;
const HEALTH_CACHE_TTL_MS = 60_000;
const RESOLUTION_WARN_INTERVAL_MS = 5 * 60_000;
const MAX_TRACKED_RESOLUTION_WARNINGS = 64;

/** Model inventory for one routing decision. */
export interface AuxiliaryRoutingInventory {
  ids: string[];
  /** True when the inventory could not be determined, as opposed to being empty. */
  probeFailed: boolean;
}

/**
 * Model inventory for a routing decision, distinguishing "this endpoint has no
 * models" from "we could not find out".
 *
 * `AuxiliaryLlmService.listModels` answers `[]` for both, which is right for
 * discovery — an unreachable endpoint is not a candidate — but leaves routing
 * unable to say which happened. Callers still invalidate the target either way;
 * this only lets the recorded reason distinguish "the RPC timed out" from
 * "this endpoint genuinely advertises nothing", which point at different faults.
 */
export async function listAuxiliaryModelsForRouting(
  ep: AuxiliaryLlmEndpointConfig,
  refreshManagedWorker: boolean,
): Promise<AuxiliaryRoutingInventory> {
  try {
    if (ep.source === 'worker-node') {
      const models = await resolveAuxiliaryWorkerModels(ep, refreshManagedWorker, PROBE_TIMEOUT_MS);
      return { ids: models.map((model) => model.id), probeFailed: false };
    }
    if (ep.provider === 'ollama') {
      const models = await listOllamaModels(ep.baseUrl, PROBE_TIMEOUT_MS);
      return { ids: models.map((model) => model.id), probeFailed: false };
    }
    const apiKey = await resolveAuxiliaryEndpointApiKey(ep);
    const models = await listOpenAiCompatibleModels(ep.baseUrl, apiKey, PROBE_TIMEOUT_MS);
    return { ids: models.map((model) => model.id), probeFailed: false };
  } catch (error) {
    logger.warn('Auxiliary model inventory probe failed; inventory unknown for this call', {
      endpointId: ep.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ids: [], probeFailed: true };
  }
}

/**
 * Emits at most one warning per slot+reason per window.
 *
 * Auxiliary routing runs hundreds of times a day, so an unthrottled warn would
 * be unreadable — but staying silent is exactly how a two-week outage of the
 * whole local-model path went unnoticed.
 */
export class AuxiliaryResolutionWarningThrottle {
  private readonly lastWarnedAt = new Map<string, number>();

  warn(slot: AuxiliaryLlmSlot, detail: string, now = Date.now()): void {
    const key = `${slot}:${detail}`;
    const lastAt = this.lastWarnedAt.get(key);
    if (lastAt !== undefined && now - lastAt < RESOLUTION_WARN_INTERVAL_MS) return;
    // Bounded: reasons embed endpoint ids, so an unbounded map would grow with
    // every endpoint the user ever configures.
    if (this.lastWarnedAt.size >= MAX_TRACKED_RESOLUTION_WARNINGS) {
      this.lastWarnedAt.clear();
    }
    this.lastWarnedAt.set(key, now);
    logger.warn('Auxiliary slot fell back to no local model', { slot, detail });
  }
}

/** Cached healthy/unhealthy verdict per endpoint. */
interface EndpointHealthEntry {
  healthy: boolean;
  checkedAt: number;
}

/**
 * Short-lived health verdicts for auxiliary endpoints, so a routing decision
 * does not re-probe an endpoint it checked seconds ago. Extracted from
 * `AuxiliaryLlmService` purely to keep that file under its size ceiling;
 * behaviour is unchanged.
 */
export class AuxiliaryEndpointHealthCache {
  private entries = new Map<string, EndpointHealthEntry>();

  clear(): void {
    this.entries.clear();
  }

  async isHealthy(
    ep: AuxiliaryLlmEndpointConfig,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    const cached = this.entries.get(ep.id);
    if (cached && Date.now() - cached.checkedAt < HEALTH_CACHE_TTL_MS) {
      return cached.healthy;
    }

    let healthy: boolean;
    try {
      if (ep.source === 'worker-node') {
        // Healthy only when the node is connected AND its heartbeat reports the local model server up.
        healthy = !!ep.workerNodeId && auxiliaryRemoteHooks.isNodeConnected(ep.workerNodeId)
          && workerEndpointHealthy(auxiliaryRemoteHooks.connectedWorkerNodes(), ep.workerNodeId, ep.provider, ep.baseUrl);
      } else if (ep.provider === 'ollama') {
        healthy = signal
          ? await probeOllamaEndpoint(ep.baseUrl, PROBE_TIMEOUT_MS, signal)
          : await probeOllamaEndpoint(ep.baseUrl, PROBE_TIMEOUT_MS);
      } else {
        const apiKey = await resolveAuxiliaryEndpointApiKey(ep);
        if (signal?.aborted) return false;
        healthy = signal
          ? await probeOpenAiCompatibleEndpoint(ep.baseUrl, apiKey, PROBE_TIMEOUT_MS, signal)
          : await probeOpenAiCompatibleEndpoint(ep.baseUrl, apiKey, PROBE_TIMEOUT_MS);
      }
    } catch {
      healthy = false;
    }

    if (!signal?.aborted) this.entries.set(ep.id, { healthy, checkedAt: Date.now() });
    return healthy;
  }
}
