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
import { REMOTE_QUEUE_PUSH_GUARD_UNSUPPORTED } from '../remote-queue-push-guard';

const remoteLocation = { type: 'remote' as const, nodeId: 'worker-node' };
const baseOptions: UnifiedSpawnOptions = {
  workingDirectory: '/repo',
  sessionId: 'remote-queue',
  accountRoute: { provider: 'claude', profileId: 'legacy', source: 'persisted', executionNodeId: 'worker-node' },
};

describe('adapter factory — Plan Queue push guard on a worker node', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.capabilities = undefined;
    mocks.sendRpc.mockResolvedValue({ instanceId: 'remote-queue' });
    mocks.getConnection.mockReturnValue({ sendRpc: mocks.sendRpc, isNodeConnected: () => true });
  });

  describe('on a worker that does not advertise the guard', () => {
    it.each<Partial<WorkerNodeCapabilities> | undefined>([
      undefined,
      { platform: 'win32' },
      { platform: 'win32', queuePushGuard: '1' as unknown as 1 },
      { platform: 'win32', queuePushGuard: 2 as unknown as 1 },
    ])('refuses a queue session before any connection exists (%j)', (capabilities) => {
      mocks.capabilities = capabilities;
      expect(() => createCliAdapter('claude', { ...baseOptions, queuePushGuard: true }, remoteLocation))
        .toThrow(REMOTE_QUEUE_PUSH_GUARD_UNSUPPORTED);
      expect(mocks.getConnection).not.toHaveBeenCalled();
    });

    it('leaves an ordinary remote session alone', async () => {
      mocks.capabilities = { platform: 'win32' };
      const adapter = createCliAdapter('claude', baseOptions, remoteLocation);
      expect(adapter).toBeInstanceOf(RemoteCliAdapter);
      await (adapter as RemoteCliAdapter).spawn();
      expect(mocks.sendRpc.mock.calls[0][2]).not.toHaveProperty('queuePushGuard');
    });
  });

  describe('on a worker that builds the guard', () => {
    beforeEach(() => { mocks.capabilities = { platform: 'win32', queuePushGuard: 1 }; });

    it.each(['claude', 'codex', 'gemini', 'copilot', 'cursor', 'opencode', 'grok', 'antigravity'] as const)(
      'sends the flag in the spawn request for %s',
      async (cliType) => {
        const { accountRoute, ...unrouted } = baseOptions;
        const routing: Partial<UnifiedSpawnOptions> = cliType === 'claude' || cliType === 'codex'
          ? { accountRoute: { ...accountRoute!, provider: cliType } }
          : cliType === 'copilot' ? { copilotAccountRoute: { profileId: 'legacy', source: 'persisted', executionNodeId: 'worker-node' } } : {};
        const adapter = createCliAdapter(cliType, { ...unrouted, ...routing, queuePushGuard: true }, remoteLocation) as RemoteCliAdapter;
        await adapter.spawn();
        expect(mocks.sendRpc).toHaveBeenCalledWith('worker-node', 'instance.spawn', expect.objectContaining({ cliType, queuePushGuard: true }));
      },
    );

    it('sends the flag with the Claude deny rules, and never the controller\'s environment', async () => {
      const adapter = createCliAdapter('claude', { ...baseOptions, queuePushGuard: true, env: { SOME_LOCAL_VALUE: 'x' }, disallowedTools: ['Bash(git push:*)'] }, remoteLocation) as RemoteCliAdapter;
      await adapter.spawn();
      const params = mocks.sendRpc.mock.calls[0][2] as Record<string, unknown>;
      expect(params['queuePushGuard']).toBe(true);
      expect(params['disallowedTools']).toContain('Bash(git push:*)');
      expect(params).not.toHaveProperty('env');
    });

    it('refuses at spawn time if the node re-registered on a build without the guard', async () => {
      const adapter = createCliAdapter('claude', { ...baseOptions, queuePushGuard: true }, remoteLocation) as RemoteCliAdapter;
      mocks.capabilities = { platform: 'win32' };
      await expect(adapter.spawn()).rejects.toThrow(REMOTE_QUEUE_PUSH_GUARD_UNSUPPORTED);
      expect(mocks.sendRpc).not.toHaveBeenCalled();
    });
  });
});
