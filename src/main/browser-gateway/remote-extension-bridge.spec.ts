import { describe, expect, it, vi } from 'vitest';
import { RemoteBrowserExtensionBridge } from './remote-extension-bridge';

function makeBridge() {
  const service = {
    attachExistingTab: vi.fn(async (request: unknown) => ({
      decision: 'allowed' as const,
      outcome: 'succeeded' as const,
      auditId: 'audit-1',
      data: request,
    })),
  };
  const commandStore = {
    pollCommand: vi.fn(async () => null),
    resolveCommand: vi.fn(),
    rejectQueue: vi.fn(),
  };
  const tabStore = {
    expireNode: vi.fn(),
  };
  const registry = {
    getNode: vi.fn(() => ({ id: 'node-1', name: 'Windows PC' })),
  };
  const bridge = new RemoteBrowserExtensionBridge({
    service,
    commandStore,
    tabStore,
    registry,
    now: () => 1_000,
    maxRequestsPerWindow: 10,
  });
  return { bridge, service, commandStore, tabStore, registry };
}

describe('RemoteBrowserExtensionBridge', () => {
  it('attaches a remote tab with node metadata and strips remote allowed origins', async () => {
    const { bridge, service } = makeBridge();

    const result = await bridge.attachTab('node-1', {
      extensionOrigin: 'chrome-extension://remote/',
      payload: {
        tabId: 42,
        windowId: 7,
        url: 'https://example.com/page',
        title: 'Example',
        allowedOrigins: [{
          scheme: 'https',
          hostPattern: '*.example.com',
          includeSubdomains: true,
        }],
        extensionOrigin: 'chrome-extension://payload/',
      },
    });

    expect(result.decision).toBe('allowed');
    expect(service.attachExistingTab).toHaveBeenCalledWith({
      tabId: 42,
      windowId: 7,
      url: 'https://example.com/page',
      title: 'Example',
      extensionOrigin: 'chrome-extension://remote/',
      provider: 'orchestrator',
      nodeId: 'node-1',
      nodeName: 'Windows PC',
    });
  });

  it('routes command polling and results through the node queue key', async () => {
    const { bridge, commandStore } = makeBridge();

    await bridge.pollCommand('node-1', { timeoutMs: 500 });
    bridge.commandResult('node-1', {
      commandId: 'cmd-1',
      ok: true,
      result: { value: 1 },
    });

    expect(commandStore.pollCommand).toHaveBeenCalledWith('node:node-1', { timeoutMs: 500 });
    expect(commandStore.resolveCommand).toHaveBeenCalledWith({
      queueKey: 'node:node-1',
      commandId: 'cmd-1',
      ok: true,
      result: { value: 1 },
    });
  });

  it('expires node tabs and rejects pending node commands on disconnect', () => {
    const { bridge, commandStore, tabStore } = makeBridge();

    bridge.expireNode('node-1');

    expect(tabStore.expireNode).toHaveBeenCalledWith('node-1');
    expect(commandStore.rejectQueue).toHaveBeenCalledWith(
      'node:node-1',
      'Remote browser extension node disconnected: node-1',
    );
  });

  it('rate limits excessive requests per node', async () => {
    const { service, commandStore, tabStore, registry } = makeBridge();
    const bridge = new RemoteBrowserExtensionBridge({
      service,
      commandStore,
      tabStore,
      registry,
      now: () => 2_000,
      maxRequestsPerWindow: 1,
      rateLimitWindowMs: 1_000,
    });

    await bridge.pollCommand('node-1', {});

    expect(() => bridge.commandResult('node-1', {
      commandId: 'cmd-1',
      ok: false,
      error: 'failed',
    })).toThrow('browser_extension_relay_rate_limited:node-1');
  });
});
