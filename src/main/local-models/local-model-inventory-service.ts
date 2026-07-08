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
}

export interface LocalModelInventoryUpdatedPayload {
  models: LocalModelInventoryEntry[];
}

export class LocalModelInventoryService extends EventEmitter {
  constructor(private readonly options: LocalModelInventoryServiceOptions = {}) {
    super();
  }

  list(): LocalModelInventoryEntry[] {
    const now = Date.now();
    return this.roster().list().flatMap((node) => entriesForNode(node, now));
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

  refresh(): LocalModelInventoryEntry[] {
    const models = this.list();
    this.emit(LOCAL_MODEL_INVENTORY_UPDATED_EVENT, { models });
    return models;
  }

  private roster(): RosterLike {
    return this.options.roster ?? getRemoteNodeRosterService();
  }
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
