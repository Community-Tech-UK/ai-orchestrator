import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkerNodeInfo } from '../../../shared/types/worker-node.types';

const getNodeMock = vi.fn();
const spawnMock = vi.fn();
const writeMock = vi.fn();
const sendServiceRpcMock = vi.fn();

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock('../worker-node-registry', () => ({
  getWorkerNodeRegistry: () => ({ getNode: getNodeMock }),
}));
vi.mock('../remote-terminal-manager', () => ({
  getRemoteTerminalManager: () => ({ spawn: spawnMock, write: writeMock }),
}));
vi.mock('../service-rpc-client', () => ({
  sendServiceRpc: (...args: unknown[]) => sendServiceRpcMock(...args),
}));

import { runBrowserLoginOnNode } from '../browser-login-launcher';

function node(overrides: Partial<WorkerNodeInfo['capabilities']> = {}): WorkerNodeInfo {
  return {
    id: 'n1',
    name: 'windows-pc',
    address: '10.0.0.2',
    status: 'connected',
    activeInstances: 0,
    capabilities: {
      platform: 'win32',
      arch: 'x64',
      cpuCores: 8,
      totalMemoryMB: 16000,
      availableMemoryMB: 8000,
      supportedClis: ['claude'],
      hasBrowserRuntime: true,
      hasBrowserMcp: true,
      hasAndroidMcp: false,
      hasDocker: false,
      maxConcurrentInstances: 10,
      workingDirectories: ['C:\\Work'],
      browsableRoots: [],
      discoveredProjects: [],
      browserAutomation: { enabled: true, headless: false, profileDir: 'C:\\profile', running: false },
      ...overrides,
    },
  };
}

describe('runBrowserLoginOnNode', () => {
  beforeEach(() => {
    getNodeMock.mockReset();
    spawnMock.mockReset().mockResolvedValue({ sessionId: 's1', pid: 123, nodeId: 'n1' });
    writeMock.mockReset().mockResolvedValue(undefined);
    sendServiceRpcMock.mockReset().mockResolvedValue({ ok: true });
  });

  it('throws when the node is not connected', async () => {
    getNodeMock.mockReturnValue(undefined);
    await expect(runBrowserLoginOnNode('n1')).rejects.toThrow(/not connected/);
  });

  it('throws when the node has no automation profile configured', async () => {
    getNodeMock.mockReturnValue(node({ browserAutomation: undefined }));
    await expect(runBrowserLoginOnNode('n1')).rejects.toThrow(/no browser-automation profile/);
  });

  it('throws when the node has no working directory', async () => {
    getNodeMock.mockReturnValue(node({ workingDirectories: [] }));
    await expect(runBrowserLoginOnNode('n1')).rejects.toThrow(/no working directory/);
  });

  it('stops the managed Chrome before launching the login Chrome', async () => {
    getNodeMock.mockReturnValue(node());
    await runBrowserLoginOnNode('n1');
    expect(sendServiceRpcMock).toHaveBeenCalledWith('n1', 'browser.stopManaged', {});
  });

  it('still launches login if stopManaged fails (best-effort)', async () => {
    getNodeMock.mockReturnValue(node());
    sendServiceRpcMock.mockRejectedValueOnce(new Error('old worker'));
    const result = await runBrowserLoginOnNode('n1');
    expect(result).toEqual({ sessionId: 's1' });
    expect(spawnMock).toHaveBeenCalled();
  });

  it('spawns a terminal and writes the login command', async () => {
    getNodeMock.mockReturnValue(node());
    const result = await runBrowserLoginOnNode('n1', 'https://www.facebook.com');

    expect(spawnMock).toHaveBeenCalledWith({ nodeId: 'n1', cwd: 'C:\\Work', shell: 'powershell.exe' });
    expect(writeMock).toHaveBeenCalledTimes(1);
    const [sessionId, data] = writeMock.mock.calls[0];
    expect(sessionId).toBe('s1');
    expect(data).toContain('Start-Process');
    expect(data).toContain('--user-data-dir=C:\\profile');
    expect(data).toContain('facebook.com');
    expect(data.endsWith('\r')).toBe(true);
    expect(result).toEqual({ sessionId: 's1' });
  });
});
