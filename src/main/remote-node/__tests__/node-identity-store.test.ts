import { describe, it, expect, beforeEach } from 'vitest';
import { NodeIdentityStore } from '../node-identity-store';
import type { NodeIdentity } from '../../../shared/types/worker-node.types';

describe('NodeIdentityStore', () => {
  let store: NodeIdentityStore;

  beforeEach(() => {
    store = new NodeIdentityStore();
    store.loadFromJson('{}');
  });

  const makeIdentity = (id: string): NodeIdentity => {
    const timestamp = Date.now();
    return {
      sessionId: `session-${id}`,
      nodeId: id,
      nodeName: `node-${id}`,
      transportToken: 'a'.repeat(64),
      token: 'a'.repeat(64),
      issuedAt: timestamp,
      createdAt: timestamp,
      lastSeenAt: timestamp,
      authMethod: 'pairing_credential',
    };
  };

  it('stores and retrieves a node identity', () => {
    const identity = makeIdentity('abc');
    store.set(identity);
    expect(store.get('abc')).toEqual(identity);
  });

  it('returns undefined for unknown nodeId', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('removes a node identity', () => {
    store.set(makeIdentity('abc'));
    store.remove('abc');
    expect(store.get('abc')).toBeUndefined();
  });

  it('lists all identities', () => {
    store.set(makeIdentity('a'));
    store.set(makeIdentity('b'));
    expect(store.getAll()).toHaveLength(2);
  });

  it('serializes to JSON and back', () => {
    store.set(makeIdentity('x'));
    const json = store.toJson();
    const store2 = new NodeIdentityStore();
    store2.loadFromJson(json);
    expect(store2.get('x')).toEqual(store.get('x'));
  });

  it('finds node by token', () => {
    const id = makeIdentity('z');
    id.transportToken = 'unique_token'.padEnd(64, '0');
    id.token = 'unique_token'.padEnd(64, '0');
    store.set(id);
    expect(store.findByToken(id.token)?.nodeId).toBe('z');
  });

  it('hydrates legacy identities into enriched session records', () => {
    store.loadFromJson(JSON.stringify({
      legacy: {
        nodeId: 'legacy',
        nodeName: 'legacy-node',
        token: 'b'.repeat(64),
        createdAt: 123,
      },
    }));

    expect(store.get('legacy')).toEqual(expect.objectContaining({
      sessionId: 'legacy-session:legacy',
      transportToken: 'b'.repeat(64),
      token: 'b'.repeat(64),
      issuedAt: 123,
      createdAt: 123,
      lastSeenAt: 123,
    }));
  });

  it('returns undefined when token not found', () => {
    expect(store.findByToken('nonexistent')).toBeUndefined();
  });

  it('handles invalid JSON gracefully', () => {
    store.loadFromJson('not valid json');
    expect(store.getAll()).toHaveLength(0);
  });
});
