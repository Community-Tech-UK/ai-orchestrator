import { describe, it, expect, beforeEach } from 'vitest';
import { NodeIdentityStore } from '../node-identity-store';
import type { NodeIdentity } from '../../../shared/types/worker-node.types';

describe('NodeIdentityStore', () => {
  let store: NodeIdentityStore;

  beforeEach(() => {
    store = new NodeIdentityStore();
    store.loadFromJson('{}');
  });

  const makeIdentity = (id: string): NodeIdentity => ({
    nodeId: id,
    nodeName: `node-${id}`,
    token: 'a'.repeat(64),
    createdAt: Date.now(),
  });

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
    id.token = 'unique_token'.padEnd(64, '0');
    store.set(id);
    expect(store.findByToken(id.token)?.nodeId).toBe('z');
  });

  it('returns undefined when token not found', () => {
    expect(store.findByToken('nonexistent')).toBeUndefined();
  });

  it('handles invalid JSON gracefully', () => {
    store.loadFromJson('not valid json');
    expect(store.getAll()).toHaveLength(0);
  });
});
