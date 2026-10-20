import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { UnifiedSpawnOptions } from '../adapter-factory.types';
import type { WorkerNodeCapabilities } from '../../../../shared/types/worker-node.types';

const mocks = vi.hoisted(() => ({
  sendRpc: vi.fn(),
  getConnection: vi.fn(),
  capabilities: undefined as Partial<WorkerNodeCapabilities> | undefined,
}));
vi.mock('../../../remote-node/worker-node-connection', () => ({
  getWorkerNodeConnectionServer: mocks.getConnection,
}));
vi.mock('../../../remote-node/worker-node-registry', () => {
  const registry = Object.assign(new EventEmitter(), {
    getNode: (nodeId: string) => (nodeId === 'worker-node' && mocks.capabilities
      ? { id: nodeId, capabilities: mocks.capabilities }
      : undefined),
  });
  return { getWorkerNodeRegistry: () => registry };
});

import { createCliAdapter } from '../adapter-factory';
import { RemoteCliAdapter } from '../remote-cli-adapter';
import { resolveRemoteClaudeSpawnPolicy } from '../remote-claude-spawn-policy';
import { applyInstanceSpawnPolicy } from '../../../instance/lifecycle/instance-spawn-policy';

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
const policies: { name: string; policy: Partial<UnifiedSpawnOptions> }[] = [
  { name: 'read-only review', policy: { readOnlyReview: true } },
  { name: 'context ceiling', policy: { contextCeilingTokens: 100_000 } },
  { name: 'turn limit', policy: { maxTurns: 8 } },
  { name: 'budget cap', policy: { maxBudgetUsd: 1 } },
  { name: 'machine-session policy', policy: { machineSession: 'review' } },
  { name: 'run_on_node machine session', policy: { machineSession: 'node-run' } },
  {
    name: 'read-only yolo reviewer with limits',
    policy: { readOnlyReview: true, yoloMode: true, machineSession: 'review', maxTurns: 8, contextCeilingTokens: 100_000 },
  },
];

describe('adapter factory — remote Claude policy enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.capabilities = undefined;
    mocks.sendRpc.mockResolvedValue({ instanceId: 'remote-claude' });
    mocks.getConnection.mockReturnValue({ sendRpc: mocks.sendRpc, isNodeConnected: () => true });
  });

  describe('on a worker that does not advertise the Claude spawn policy', () => {
    it.each(policies)('refuses $name before constructing a remote connection', ({ policy }) => {
      mocks.capabilities = { platform: 'win32' };
      expect(() => createCliAdapter('claude', { ...baseOptions, ...policy }, remoteLocation))
        .toThrow('Remote Claude execution cannot enforce');
      expect(mocks.getConnection).not.toHaveBeenCalled();
    });

    it.each<Partial<WorkerNodeCapabilities> | undefined>([
      undefined,
      { claudeSpawnPolicy: '1' as unknown as 1 },
      { claudeSpawnPolicy: 2 as unknown as 1 },
    ])('fails closed for an unknown node or a malformed capability (%j)', (capabilities) => {
      mocks.capabilities = capabilities;
      expect(() => createCliAdapter('claude', { ...baseOptions, machineSession: 'node-run' }, remoteLocation))
        .toThrow('Remote Claude execution cannot enforce');
    });

    it.each<Partial<UnifiedSpawnOptions>>([
      {},
      { readOnlyReview: false, contextCeilingTokens: 0, maxTurns: 0, maxBudgetUsd: 0 },
    ])('preserves ordinary remote sessions with no active policy (%j)', (options) => {
      const adapter = createCliAdapter('claude', { ...baseOptions, ...options }, remoteLocation);

      expect(adapter).toBeInstanceOf(RemoteCliAdapter);
      expect(adapter.getName()).toBe('remote:claude');
      expect(mocks.getConnection).toHaveBeenCalledTimes(1);
    });
  });

  describe('on a worker that enforces the Claude spawn policy', () => {
    beforeEach(() => { mocks.capabilities = { platform: 'win32', claudeSpawnPolicy: 1 }; });

    it.each(policies)('accepts $name and carries it to the worker', async ({ policy }) => {
      const adapter = createCliAdapter('claude', { ...baseOptions, ...policy }, remoteLocation);
      expect(adapter).toBeInstanceOf(RemoteCliAdapter);

      await (adapter as RemoteCliAdapter).spawn();

      const expected = resolveRemoteClaudeSpawnPolicy({ ...baseOptions, ...policy });
      expect(expected).toBeDefined();
      expect(mocks.sendRpc).toHaveBeenCalledWith('worker-node', 'instance.spawn', expect.objectContaining({
        cliType: 'claude',
        claudeSpawnPolicy: expected,
      }));
    });

    it('sends no policy for an ordinary session', async () => {
      const adapter = createCliAdapter('claude', baseOptions, remoteLocation) as RemoteCliAdapter;
      await adapter.spawn();

      expect(mocks.sendRpc.mock.calls[0][2]).not.toHaveProperty('claudeSpawnPolicy');
    });

    it('refuses at spawn time if the node re-registered on a build without support', async () => {
      const adapter = createCliAdapter('claude', { ...baseOptions, machineSession: 'node-run' }, remoteLocation) as RemoteCliAdapter;
      mocks.capabilities = { platform: 'win32' };

      await expect(adapter.spawn()).rejects.toThrow('Remote Claude execution cannot enforce');
      expect(mocks.sendRpc).not.toHaveBeenCalled();
    });

    it('carries the run_on_node machine session stamped by the instance spawn policy', async () => {
      // orchestrator-tools-step.ts spawnRemoteInstance: metadata for a call made by an agent session.
      const options = applyInstanceSpawnPolicy('claude', {
        id: 'run-on-node-child',
        depth: 0,
        parentId: null,
        additionalDirectories: undefined,
        metadata: { spawnDepth: 1, hideFromProjectRail: true, spawnParentInstanceId: 'caller-session' },
      }, { ...baseOptions, yoloMode: true });
      expect(options.machineSession).toBe('node-run');

      const adapter = createCliAdapter('claude', options, remoteLocation) as RemoteCliAdapter;
      await adapter.spawn();

      expect(mocks.sendRpc).toHaveBeenCalledWith('worker-node', 'instance.spawn', expect.objectContaining({
        yoloMode: true,
        claudeSpawnPolicy: expect.objectContaining({ machineSession: 'node-run' }),
      }));
    });
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

describe('resolveRemoteClaudeSpawnPolicy', () => {
  it('resolves the settings-derived context ceiling the way a local Claude spawn does', () => {
    const readCeiling = vi.fn((machineSession: boolean) => (machineSession ? 300_000 : undefined));

    expect(resolveRemoteClaudeSpawnPolicy({ ...baseOptions, machineSession: 'node-run' }, readCeiling))
      .toEqual({ machineSession: 'node-run', contextCeilingTokens: 300_000 });
    expect(readCeiling).toHaveBeenLastCalledWith(true);
    expect(resolveRemoteClaudeSpawnPolicy(baseOptions, readCeiling)).toBeUndefined();
    expect(readCeiling).toHaveBeenLastCalledWith(false);
  });

  it('prefers an explicit context ceiling over the setting', () => {
    expect(resolveRemoteClaudeSpawnPolicy({ ...baseOptions, contextCeilingTokens: 150_000 }, () => 900_000))
      .toEqual({ contextCeilingTokens: 150_000 });
  });

  it('rejects a value the worker could not accept instead of sending it', () => {
    expect(() => resolveRemoteClaudeSpawnPolicy({ ...baseOptions, maxTurns: 2.5 }, () => undefined)).toThrow();
  });
});
