import { describe, expect, it, vi } from 'vitest';
import { OrchestratorToolsRpcServer } from './orchestrator-tools-rpc-server';
import { createOrchestratorToolDefinitions } from './orchestrator-tools';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));

describe('test extension install through the parent dispatcher', () => {
  const result = { nodeId: 'n1', nodeName: 'pc' };
  const build = () => {
    const install = vi.fn(async () => result);
    const restore = vi.fn(async () => result);
    const server = new OrchestratorToolsRpcServer({
      userDataPath: '/tmp',
      operatorDbPath: '/tmp/unused-test-extension-install.db',
      isKnownLocalInstance: (id) => id === 'caller',
      registerCleanup: () => undefined,
      toolFactory: createOrchestratorToolDefinitions,
      installTestBrowserExtension: install as never,
      restoreTestBrowserExtension: restore as never,
    });
    const request = (method: string, payload: Record<string, unknown>, instanceId = 'caller') =>
      server.handleRequest({ jsonrpc: '2.0', id: 1, method, params: { instanceId, payload } });
    return { install, restore, request };
  };

  it('passes the known calling session to install and restore', async () => {
    const { install, restore, request } = build();
    await request('orchestrator_tools.install_test_browser_extension', { node: 'pc', sourceDir: 'build/ext' });
    await request('orchestrator_tools.restore_test_browser_extension', { node: 'pc' });
    expect(install).toHaveBeenCalledWith({ node: 'pc', sourceDir: 'build/ext', instanceId: 'caller' });
    expect(restore).toHaveBeenCalledWith({ node: 'pc', instanceId: 'caller' });
  });

  it('refuses an unknown session before either tool runs', async () => {
    const { install, restore, request } = build();
    await expect(request('orchestrator_tools.install_test_browser_extension', { node: 'pc', sourceDir: 'x' }, 'stranger'))
      .rejects.toThrow('unknown orchestrator-tools instance');
    await expect(request('orchestrator_tools.restore_test_browser_extension', { node: 'pc' }, 'stranger'))
      .rejects.toThrow('unknown orchestrator-tools instance');
    expect(install).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });
});
