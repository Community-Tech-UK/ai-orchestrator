import type { NodeIdentity } from '../../shared/types/worker-node.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('NodeIdentityStore');

let instance: NodeIdentityStore | null = null;

export class NodeIdentityStore {
  private nodes = new Map<string, NodeIdentity>();

  static getInstance(): NodeIdentityStore {
    if (!instance) {
      instance = new NodeIdentityStore();
    }
    return instance;
  }

  static _resetForTesting(): void {
    instance = null;
  }

  get(nodeId: string): NodeIdentity | undefined {
    return this.nodes.get(nodeId);
  }

  set(identity: NodeIdentity): void {
    this.nodes.set(identity.nodeId, identity);
    logger.info('Node identity stored', { nodeId: identity.nodeId, name: identity.nodeName });
  }

  remove(nodeId: string): boolean {
    const deleted = this.nodes.delete(nodeId);
    if (deleted) {
      logger.info('Node identity removed', { nodeId });
    }
    return deleted;
  }

  getAll(): NodeIdentity[] {
    return [...this.nodes.values()];
  }

  findByToken(token: string): NodeIdentity | undefined {
    for (const identity of this.nodes.values()) {
      if (identity.token === token) return identity;
    }
    return undefined;
  }

  toJson(): string {
    const record: Record<string, NodeIdentity> = {};
    for (const [key, val] of this.nodes) {
      record[key] = val;
    }
    return JSON.stringify(record);
  }

  loadFromJson(json: string): void {
    try {
      const record = JSON.parse(json) as Record<string, NodeIdentity>;
      this.nodes.clear();
      for (const [key, val] of Object.entries(record)) {
        this.nodes.set(key, val);
      }
    } catch (err) {
      logger.error('Failed to parse node identity JSON', err instanceof Error ? err : new Error(String(err)));
      this.nodes.clear();
    }
  }
}

export function getNodeIdentityStore(): NodeIdentityStore {
  return NodeIdentityStore.getInstance();
}
