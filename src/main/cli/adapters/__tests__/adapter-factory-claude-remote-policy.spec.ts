import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { UnifiedSpawnOptions } from '../adapter-factory.types';

const mocks = vi.hoisted(() => ({ getConnection: vi.fn(() => ({})) }));
vi.mock('../../../remote-node/worker-node-connection', () => ({
  getWorkerNodeConnectionServer: mocks.getConnection,
}));
vi.mock('../../../remote-node/worker-node-registry', () => ({
  getWorkerNodeRegistry: () => new EventEmitter(),
}));

import { createCliAdapter } from '../adapter-factory';
import { RemoteCliAdapter } from '../remote-cli-adapter';

const remoteLocation = { type: 'remote' as const, nodeId: 'worker-node' };
const baseOptions: UnifiedSpawnOptions = {
  workingDirectory: '/repo',
  sessionId: 'remote-claude',
  accountRoute: {
    provider: 'claude',
    profileId: 'legacy',
    source: 'persisted',
    executionNodeId: 'worker-node',
  },
};

describe('adapter factory — remote Claude policy enforcement', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each<{ name: string; policy: Partial<UnifiedSpawnOptions> }>([
    { name: 'read-only review', policy: { readOnlyReview: true } },
    { name: 'context ceiling', policy: { contextCeilingTokens: 100_000 } },
    { name: 'turn limit', policy: { maxTurns: 8 } },
    { name: 'machine-session policy', policy: { machineSession: 'review' } },
    {
      name: 'read-only yolo reviewer with limits',
      policy: { readOnlyReview: true, yoloMode: true, machineSession: 'review', maxTurns: 8, contextCeilingTokens: 100_000 },
    },
  ])('refuses $name before constructing a remote connection', ({ policy }) => {
    expect(() => createCliAdapter('claude', { ...baseOptions, ...policy }, remoteLocation))
      .toThrow('Remote Claude execution cannot enforce');
    expect(mocks.getConnection).not.toHaveBeenCalled();
  });

  it.each<Partial<UnifiedSpawnOptions>>([
    {},
    { readOnlyReview: false, contextCeilingTokens: 0, maxTurns: 0 },
  ])('preserves ordinary remote sessions with no active policy (%j)', (options) => {
    const adapter = createCliAdapter('claude', { ...baseOptions, ...options }, remoteLocation);

    expect(adapter).toBeInstanceOf(RemoteCliAdapter);
    expect(adapter.getName()).toBe('remote:claude');
    expect(mocks.getConnection).toHaveBeenCalledTimes(1);
  });

  it('keeps policy-bearing local Claude on the canonical adapter', () => {
    const adapter = createCliAdapter('claude', {
      ...baseOptions,
      readOnlyReview: true,
      yoloMode: true,
      machineSession: 'review',
      maxTurns: 8,
      contextCeilingTokens: 100_000,
    });

    expect(adapter.getName()).toBe('claude-cli');
    expect(adapter).not.toBeInstanceOf(RemoteCliAdapter);
    expect(mocks.getConnection).not.toHaveBeenCalled();
  });
});
