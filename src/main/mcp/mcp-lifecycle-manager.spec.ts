import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpLifecycleManager } from './mcp-lifecycle-manager';

class FakeMcpManager extends EventEmitter {
  connect = vi.fn(async (serverId: string) => {
    this.emit('server:phase', serverId, 'transport', 'running');
    this.emit('server:phase', serverId, 'transport', 'succeeded');
    this.emit('server:phase', serverId, 'initialize', 'running');
    this.emit('server:phase', serverId, 'initialize', 'succeeded');
    this.emit('server:phase', serverId, 'discover', 'running');
    this.emit('server:phase', serverId, 'discover', 'succeeded');
    this.emit('server:connected', serverId);
  });
  disconnect = vi.fn(async () => undefined);
  restart = vi.fn(async (serverId: string) => {
    await this.connect(serverId);
  });
  getState = vi.fn(() => ({ servers: [], tools: [], resources: [], prompts: [] }));
  getServers = vi.fn(() => [{ id: 'server-1', name: 'Server 1', transport: 'stdio', status: 'connected' }]);
}

describe('McpLifecycleManager', () => {
  let manager: FakeMcpManager;
  let lifecycle: McpLifecycleManager;

  beforeEach(() => {
    manager = new FakeMcpManager();
    lifecycle = new McpLifecycleManager(manager as never);
  });

  it('tracks phase progress and exposes merged server state', async () => {
    await lifecycle.connect('server-1');

    const report = lifecycle.getServerReport('server-1');
    expect(report?.status).toBe('connected');
    expect(report?.phases.find((phase) => phase.phase === 'discover')?.state).toBe('succeeded');
    expect(lifecycle.getServers()[0]?.lifecycle?.status).toBe('connected');
  });

  it('retries once after an initial failure', async () => {
    manager.connect
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    await lifecycle.connect('server-1');

    expect(manager.disconnect).toHaveBeenCalledWith('server-1');
    expect(manager.connect).toHaveBeenCalledTimes(2);
    expect(lifecycle.getServerReport('server-1')?.retryCount).toBe(1);
  });
});
