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
    this.nodes.set(identity.nodeId, normalizeIdentity(identity.nodeId, identity));
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

  findByTransportToken(token: string): NodeIdentity | undefined {
    for (const identity of this.nodes.values()) {
      if (identity.transportToken === token) return identity;
    }
    return undefined;
  }

  findByToken(token: string): NodeIdentity | undefined {
    return this.findByTransportToken(token);
  }

  touch(nodeId: string, updates: Partial<Pick<NodeIdentity, 'nodeName' | 'lastSeenAt'>> = {}): NodeIdentity | undefined {
    const current = this.nodes.get(nodeId);
    if (!current) {
      return undefined;
    }

    const next: NodeIdentity = {
      ...current,
      ...(updates.nodeName ? { nodeName: updates.nodeName } : {}),
      lastSeenAt: updates.lastSeenAt ?? Date.now(),
    };
    this.nodes.set(nodeId, next);
    return next;
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
      const record = JSON.parse(json) as Record<string, Partial<NodeIdentity>>;
      this.nodes.clear();
      for (const [key, val] of Object.entries(record)) {
        this.nodes.set(key, normalizeIdentity(key, val));
      }
    } catch (err) {
      logger.error('Failed to parse node identity JSON', err instanceof Error ? err : new Error(String(err)));
      this.nodes.clear();
    }
  }
}

function normalizeIdentity(nodeId: string, identity: Partial<NodeIdentity>): NodeIdentity {
  const transportToken = typeof identity.transportToken === 'string'
    ? identity.transportToken
    : (typeof identity.token === 'string' ? identity.token : '');
  const issuedAt = typeof identity.issuedAt === 'number'
    ? identity.issuedAt
    : (typeof identity.createdAt === 'number' ? identity.createdAt : Date.now());

  const authMethod = identity.authMethod === 'manual_pairing'
    ? 'manual_pairing'
    : 'pairing_credential';

  return {
    sessionId: typeof identity.sessionId === 'string' && identity.sessionId.trim().length > 0
      ? identity.sessionId
      : `legacy-session:${nodeId}`,
    nodeId,
    nodeName: typeof identity.nodeName === 'string' && identity.nodeName.trim().length > 0
      ? identity.nodeName
      : nodeId,
    transportToken,
    token: transportToken,
    issuedAt,
    createdAt: issuedAt,
    lastSeenAt: typeof identity.lastSeenAt === 'number' ? identity.lastSeenAt : issuedAt,
    authMethod,
    pairingLabel: typeof identity.pairingLabel === 'string' ? identity.pairingLabel : undefined,
  };
}

export function getNodeIdentityStore(): NodeIdentityStore {
  return NodeIdentityStore.getInstance();
}
