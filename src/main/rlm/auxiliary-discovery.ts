import {
  AUXILIARY_DISCOVERY_MAX_CANDIDATES,
  AUXILIARY_DISCOVERY_MAX_MODELS,
  AUXILIARY_WORKER_ENDPOINT_MAX_DESCRIPTORS,
  auxiliaryWorkerPhysicalSourceKey,
  type AuxiliaryLlmEndpointConfig,
  type AuxiliaryLlmModelInfo,
} from '../../shared/types/auxiliary-llm.types';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import { hostKeyFromUrl } from './auxiliary-llm-utils';

export interface AuxiliaryWorkerEndpoint {
  endpoint: AuxiliaryLlmEndpointConfig;
  models: AuxiliaryLlmModelInfo[];
  healthy: boolean;
}

interface AuxiliaryWorkerEndpointSource {
  endpoint: AuxiliaryLlmEndpointConfig;
  advertisedModels: string[];
  healthy: boolean;
}

export function auxiliaryWorkerSourceKeys(
  endpoints: AuxiliaryLlmEndpointConfig[],
): Set<string> {
  const keys = new Set<string>();
  for (const endpoint of endpoints) {
    if (endpoint.source !== 'worker-node' || !endpoint.workerNodeId) continue;
    keys.add(auxiliaryWorkerPhysicalSourceKey(
      endpoint.workerNodeId,
      endpoint.provider,
      endpoint.baseUrl,
    ));
  }
  return keys;
}

export function collectAuxiliaryWorkerEndpoints(
  nodes: WorkerNodeInfo[],
  limit = AUXILIARY_DISCOVERY_MAX_CANDIDATES,
  excludedSourceKeys: ReadonlySet<string> = new Set<string>(),
): AuxiliaryWorkerEndpoint[] {
  return collectAuxiliaryWorkerEndpointSources(nodes, limit, excludedSourceKeys).map((source) => ({
    endpoint: source.endpoint,
    models: materializeAuxiliaryWorkerModels(source.advertisedModels, source.endpoint),
    healthy: source.healthy,
  }));
}

export function collectAuxiliaryWorkerEndpointConfigs(
  nodes: WorkerNodeInfo[],
  limit = AUXILIARY_DISCOVERY_MAX_CANDIDATES,
  excludedSourceKeys: ReadonlySet<string> = new Set<string>(),
): AuxiliaryLlmEndpointConfig[] {
  return collectAuxiliaryWorkerEndpointSources(nodes, limit, excludedSourceKeys)
    .map((source) => source.endpoint);
}

export function materializeAuxiliaryWorkerModels(
  advertisedModels: string[],
  endpoint: AuxiliaryLlmEndpointConfig,
): AuxiliaryLlmModelInfo[] {
  // Cap the raw heartbeat array before object creation. This deliberately
  // preserves the first advertised 100 rather than scanning an unbounded tail.
  return advertisedModels
    .slice(0, AUXILIARY_DISCOVERY_MAX_MODELS)
    .map<AuxiliaryLlmModelInfo>((model) => ({
      id: model,
      name: model,
      provider: endpoint.provider,
      endpointId: endpoint.id,
    }));
}

/** Models a connected worker reported for the given endpoint (no direct dial). */
export function modelsForAuxiliaryWorkerEndpoint(
  nodes: WorkerNodeInfo[],
  endpoint: AuxiliaryLlmEndpointConfig,
): AuxiliaryLlmModelInfo[] {
  if (!endpoint.workerNodeId) return [];
  const expectedSourceKey = auxiliaryWorkerPhysicalSourceKey(
    endpoint.workerNodeId,
    endpoint.provider,
    endpoint.baseUrl,
  );
  let inspectedDescriptors = 0;
  for (const node of nodes) {
    if (node.id !== endpoint.workerNodeId) continue;
    for (const capability of node.capabilities.localModelEndpoints ?? []) {
      if (inspectedDescriptors >= AUXILIARY_WORKER_ENDPOINT_MAX_DESCRIPTORS) return [];
      inspectedDescriptors += 1;
      if (
        auxiliaryWorkerPhysicalSourceKey(node.id, capability.provider, capability.baseUrl)
        === expectedSourceKey
      ) {
        return materializeAuxiliaryWorkerModels(capability.models, endpoint);
      }
    }
  }
  return [];
}

function collectAuxiliaryWorkerEndpointSources(
  nodes: WorkerNodeInfo[],
  limit: number,
  excludedSourceKeys: ReadonlySet<string> = new Set<string>(),
): AuxiliaryWorkerEndpointSource[] {
  const result: AuxiliaryWorkerEndpointSource[] = [];
  const seenSourceKeys = new Set(excludedSourceKeys);
  let inspectedDescriptors = 0;
  outer: for (const node of nodes) {
    for (const capability of node.capabilities.localModelEndpoints ?? []) {
      if (
        result.length >= limit
        || inspectedDescriptors >= AUXILIARY_WORKER_ENDPOINT_MAX_DESCRIPTORS
      ) break outer;
      inspectedDescriptors += 1;
      const baseUrl = capability.baseUrl;
      const sourceKey = auxiliaryWorkerPhysicalSourceKey(
        node.id,
        capability.provider,
        baseUrl,
      );
      if (seenSourceKeys.has(sourceKey)) continue;
      seenSourceKeys.add(sourceKey);
      const endpoint: AuxiliaryLlmEndpointConfig = {
        id: `worker:${node.id}:${capability.provider}:${hostKeyFromUrl(baseUrl)}`,
        label: `${node.name} · ${capability.provider}`,
        provider: capability.provider,
        baseUrl,
        source: 'worker-node',
        workerNodeId: node.id,
        enabled: true,
      };
      result.push({
        endpoint,
        advertisedModels: capability.models,
        healthy: capability.healthy,
      });
    }
  }
  return result;
}

export async function settleBeforeAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  return new Promise<T | undefined>((resolve) => {
    let settled = false;
    const finish = (value: T | undefined): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      (value) => finish(signal.aborted ? undefined : value),
      () => finish(undefined),
    );
  });
}
