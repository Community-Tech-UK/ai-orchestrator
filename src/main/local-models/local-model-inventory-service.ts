import { EventEmitter } from 'events';
import type {
  LocalModelInventoryEntry,
  ModelRuntimeTarget,
} from '../../shared/types/local-model-runtime.types';
import type {
  RemoteNodeRosterEntry,
  WorkerLocalModelCapability,
} from '../../shared/types/worker-node.types';
import { getRemoteNodeRosterService } from '../remote-node/remote-node-roster-service';
import { encodeLocalModelSelector } from './local-model-selector';

export const LOCAL_MODEL_INVENTORY_UPDATED_EVENT = 'inventory-updated' as const;

interface RosterLike {
  list(): RemoteNodeRosterEntry[];
}

export interface LocalModelInventoryServiceOptions {
  roster?: RosterLike;
  thisDeviceProbe?: () => Promise<WorkerLocalModelCapability[]>;
}

export interface LocalModelInventoryUpdatedPayload {
  models: LocalModelInventoryEntry[];
}

export class LocalModelInventoryService extends EventEmitter {
  private thisDeviceEndpoints: WorkerLocalModelCapability[] = [];
  private thisDeviceDiscoveredAt = 0;

  constructor(private readonly options: LocalModelInventoryServiceOptions = {}) {
    super();
  }

  list(): LocalModelInventoryEntry[] {
    const now = Date.now();
    return [
      ...entriesForThisDevice(
        this.thisDeviceEndpoints,
        this.thisDeviceDiscoveredAt || now,
      ),
      ...this.roster().list().flatMap((node) => entriesForNode(node, now)),
    ];
  }

  resolveTarget(selectorId: string): ModelRuntimeTarget {
    const entry = this.list().find((candidate) => candidate.selectorId === selectorId);
    if (!entry || !entry.healthy) {
      throw new Error('Local model is no longer available');
    }
    return {
      kind: 'local-model',
      selectorId: entry.selectorId,
      source: entry.source,
      endpointProvider: entry.endpointProvider,
      endpointId: entry.endpointId,
      modelId: entry.modelId,
      ...(entry.nodeId ? { nodeId: entry.nodeId } : {}),
      ...(entry.nodeName ? { nodeName: entry.nodeName } : {}),
    };
  }

  async refresh(): Promise<LocalModelInventoryEntry[]> {
    this.thisDeviceEndpoints = await this.thisDeviceProbe();
    this.thisDeviceDiscoveredAt = Date.now();
    const models = this.list();
    this.emit(LOCAL_MODEL_INVENTORY_UPDATED_EVENT, { models });
    return models;
  }

  private roster(): RosterLike {
    return this.options.roster ?? getRemoteNodeRosterService();
  }

  private thisDeviceProbe(): Promise<WorkerLocalModelCapability[]> {
    return this.options.thisDeviceProbe
      ? this.options.thisDeviceProbe()
      : detectThisDeviceLocalModelEndpoints();
  }
}

const THIS_DEVICE_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const THIS_DEVICE_LMSTUDIO_BASE_URL = 'http://127.0.0.1:1234';
const THIS_DEVICE_PROBE_TIMEOUT_MS = 2_000;

async function detectThisDeviceLocalModelEndpoints(): Promise<WorkerLocalModelCapability[]> {
  const endpoints = await Promise.all([
    probeThisDeviceOllama(),
    probeThisDeviceLmStudio(),
  ]);
  return endpoints.filter((endpoint): endpoint is WorkerLocalModelCapability => endpoint !== null);
}

async function probeThisDeviceOllama(): Promise<WorkerLocalModelCapability | null> {
  const data = await fetchJson<{ models?: Array<{ name?: unknown }> }>(
    `${THIS_DEVICE_OLLAMA_BASE_URL}/api/tags`,
  );
  if (!data) {
    return null;
  }
  return {
    provider: 'ollama',
    endpointId: 'ollama',
    baseUrl: THIS_DEVICE_OLLAMA_BASE_URL,
    models: (data.models ?? [])
      .map((model) => model.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
    healthy: true,
  };
}

async function probeThisDeviceLmStudio(): Promise<WorkerLocalModelCapability | null> {
  const data = await fetchJson<{ data?: Array<{ id?: unknown }> }>(
    `${THIS_DEVICE_LMSTUDIO_BASE_URL}/v1/models`,
  );
  if (!data) {
    return null;
  }
  return {
    provider: 'openai-compatible',
    endpointId: 'openai-compatible',
    baseUrl: THIS_DEVICE_LMSTUDIO_BASE_URL,
    models: (data.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
    loadedModels: await probeThisDeviceLmStudioLoadedModels(),
    healthy: true,
  };
}

async function probeThisDeviceLmStudioLoadedModels() {
  const data = await fetchJson<{ data?: Array<{
    id?: unknown;
    state?: unknown;
    loaded_context_length?: unknown;
  }> }>(`${THIS_DEVICE_LMSTUDIO_BASE_URL}/api/v0/models`);
  if (!data) {
    return undefined;
  }
  return (data.data ?? [])
    .filter((model) => model.state === 'loaded' && typeof model.id === 'string')
    .map((model) => ({
      id: model.id as string,
      contextLength: typeof model.loaded_context_length === 'number'
        ? model.loaded_context_length
        : 0,
    }));
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), THIS_DEVICE_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return await response.json() as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function entriesForThisDevice(
  endpoints: WorkerLocalModelCapability[],
  discoveredAt: number,
): LocalModelInventoryEntry[] {
  return endpoints.flatMap((endpoint) => entriesForThisDeviceEndpoint(endpoint, discoveredAt));
}

function entriesForThisDeviceEndpoint(
  endpoint: WorkerLocalModelCapability,
  discoveredAt: number,
): LocalModelInventoryEntry[] {
  const endpointId = endpoint.endpointId ?? endpoint.provider;
  const loadedById = new Map((endpoint.loadedModels ?? []).map((model) => [
    model.id,
    model.contextLength,
  ]));

  return endpoint.models.map((modelId) => {
    const loadedContextLength = loadedById.get(modelId);
    return {
      selectorId: encodeLocalModelSelector({
        source: 'this-device',
        endpointProvider: endpoint.provider,
        endpointId,
        modelId,
      }),
      source: 'this-device',
      endpointProvider: endpoint.provider,
      endpointId,
      modelId,
      displayName: `${modelId} on This device`,
      healthy: endpoint.healthy,
      loaded: loadedContextLength !== undefined,
      ...(loadedContextLength !== undefined ? { loadedContextLength } : {}),
      capabilities: {
        streaming: true,
        multiTurn: true,
        toolUse: 'none',
        vision: 'unknown',
      },
      discoveredAt,
    };
  });
}

function entriesForNode(
  node: RemoteNodeRosterEntry,
  discoveredAt: number,
): LocalModelInventoryEntry[] {
  return (node.capabilities.localModelEndpoints ?? []).flatMap((endpoint) =>
    entriesForEndpoint(node, endpoint, discoveredAt),
  );
}

function entriesForEndpoint(
  node: RemoteNodeRosterEntry,
  endpoint: WorkerLocalModelCapability,
  discoveredAt: number,
): LocalModelInventoryEntry[] {
  const endpointId = endpoint.endpointId ?? endpoint.provider;
  const loadedById = new Map((endpoint.loadedModels ?? []).map((model) => [
    model.id,
    model.contextLength,
  ]));

  return endpoint.models.map((modelId) => {
    const loadedContextLength = loadedById.get(modelId);
    return {
      selectorId: encodeLocalModelSelector({
        source: 'worker-node',
        nodeId: node.id,
        endpointProvider: endpoint.provider,
        endpointId,
        modelId,
      }),
      source: 'worker-node',
      endpointProvider: endpoint.provider,
      endpointId,
      modelId,
      displayName: `${modelId} on ${node.name}`,
      nodeId: node.id,
      nodeName: node.name,
      ...(node.platform ? { platform: node.platform } : {}),
      healthy: node.connected && endpoint.healthy,
      loaded: loadedContextLength !== undefined,
      ...(loadedContextLength !== undefined ? { loadedContextLength } : {}),
      capabilities: {
        streaming: true,
        multiTurn: true,
        toolUse: 'none',
        vision: 'unknown',
      },
      discoveredAt,
    };
  });
}

let localModelInventoryService: LocalModelInventoryService | null = null;

export function getLocalModelInventoryService(): LocalModelInventoryService {
  if (!localModelInventoryService) {
    localModelInventoryService = new LocalModelInventoryService();
  }
  return localModelInventoryService;
}

export function _resetLocalModelInventoryServiceForTesting(): void {
  localModelInventoryService?.removeAllListeners();
  localModelInventoryService = null;
}
