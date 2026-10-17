import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const getNode = vi.hoisted(() => vi.fn());
const registry = Object.assign(new EventEmitter(), { getNode });
vi.mock('../../remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => registry }));
import { RemoteCliAdapter } from './remote-cli-adapter';
import type { WorkerNodeConnectionServer } from '../../remote-node/worker-node-connection';

describe('remote OpenCode feature requirements', () => {
  beforeEach(() => { registry.removeAllListeners(); vi.clearAllMocks(); });
  it.each([undefined, 1])('refuses a fork on a worker reporting major %s before sending work', async (major) => {
    getNode.mockReturnValue({ capabilities: { openCodeMajor: major } });
    const sendRpc = vi.fn();
    const adapter = new RemoteCliAdapter({ sendRpc } as unknown as WorkerNodeConnectionServer, 'worker', 'opencode', { sessionId: 'session', workingDirectory: '/workspace', forkSession: true });
    await expect(adapter.spawn()).rejects.toThrow(/OpenCode 2.0.30/);
    expect(sendRpc).not.toHaveBeenCalled();
  });
  it('keeps remote forks on transcript replay until source cloning can be proxied', () => {
    const adapter = new RemoteCliAdapter({} as WorkerNodeConnectionServer, 'worker', 'opencode', {});
    getNode.mockReturnValue({ capabilities: { openCodeMajor: 1 } });
    expect(adapter.getRuntimeCapabilities().supportsForkSession).toBe(false);
    getNode.mockReturnValue({ capabilities: { openCodeMajor: 2 } });
    expect(adapter.getRuntimeCapabilities().supportsForkSession).toBe(false);
  });
  it('forwards known transcript and additional folder data only after checking a v2 worker', async () => {
    getNode.mockReturnValue({ capabilities: { openCodeMajor: 2 } });
    const sendRpc = vi.fn().mockResolvedValue({ instanceId: 'session' });
    const adapter = new RemoteCliAdapter({ sendRpc } as unknown as WorkerNodeConnectionServer, 'worker', 'opencode', {
      sessionId: 'session', workingDirectory: '/workspace', resume: true, transcriptKnown: true, additionalDirectories: ['/another-folder'],
    });
    try {
      await adapter.spawn();
      expect(sendRpc).toHaveBeenCalledWith('worker', 'instance.spawn', expect.objectContaining({ transcriptKnown: true, additionalDirectories: ['/another-folder'] }));
    } finally { adapter.forceCleanup(); }
  });
});
