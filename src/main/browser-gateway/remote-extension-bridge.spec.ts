import { describe, expect, it, vi } from 'vitest';
import { RemoteBrowserExtensionBridge } from './remote-extension-bridge';
import { BrowserExtensionContactState } from './browser-extension-contact-state';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import { BrowserExtensionCommandStore } from './browser-extension-command-store';

function makeBridge() {
  let now = 1_000;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };
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
    confirmCommandHandoff: vi.fn(() => true),
    requeueUndeliveredCommand: vi.fn(() => true),
    resolveCommand: vi.fn(),
    rejectQueue: vi.fn(),
    markReceived: vi.fn(),
  };
  const tabStore = {
    suspendNode: vi.fn(() => 2),
    restoreNode: vi.fn(() => 0),
  };
  const reliabilityEvents = {
    record: vi.fn(),
  };
  const registry = {
    getNode: vi.fn(() => ({ id: 'node-1', name: 'Windows PC' }) as unknown as WorkerNodeInfo),
  };
  const contactState = new BrowserExtensionContactState({ now: () => now });
  const bridge = new RemoteBrowserExtensionBridge({
    service,
    commandStore,
    tabStore,
    registry,
    contactState,
    reliabilityEvents,
    logger,
    now: () => now,
    maxRequestsPerWindow: 10,
  });
  return {
    bridge,
    service,
    commandStore,
    tabStore,
    registry,
    reliabilityEvents,
    logger,
    contactState,
    setNow: (value: number) => {
      now = value;
    },
  };
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

    expect(commandStore.pollCommand).toHaveBeenCalledWith('node:node-1', {
      timeoutMs: 500,
      deferHandoffConfirmation: true,
      allowSecureCredentialCommands: false,
    });
    expect(commandStore.resolveCommand).toHaveBeenCalledWith({
      queueKey: 'node:node-1',
      commandId: 'cmd-1',
      ok: true,
      result: { value: 1 },
    });
  });

  it('returns no queued credential value to a downgraded exact remote poll', async () => {
    const { service, tabStore, registry, contactState } = makeBridge();
    const commandStore = new BrowserExtensionCommandStore();
    const bridge = new RemoteBrowserExtensionBridge({
      service,
      commandStore,
      tabStore,
      registry,
      contactState,
      now: () => 2_000,
    });
    const pending = commandStore.sendCommand({
      queueKey: 'node:node-1',
      command: 'type',
      payload: {
        selector: '#password',
        value: 'NON_SECRET_TEST_PLACEHOLDER',
        credentialOrigin: 'https://www.instagram.com',
        credentialProtection: 'password',
      },
      timeoutMs: 1_000,
    });
    const rejection = expect(pending).rejects.toThrow(
      'shared_tab_secure_credential_fill_unavailable',
    );

    await expect(bridge.pollCommand('node-1', {
      timeoutMs: 500,
      extensionVersion: '0.2.2',
      extensionStartedAt: 2_000,
    })).resolves.toBeNull();
    await rejection;
  });

  it('LT-371: requeues an unsent poll result through the node queue key', () => {
    const { bridge, commandStore } = makeBridge();

    expect(bridge.requeueUndeliveredCommand('node-1', 'cmd-1')).toBe(true);
    expect(commandStore.requeueUndeliveredCommand).toHaveBeenCalledWith(
      'node:node-1',
      'cmd-1',
    );
  });

  it('LT-371: confirms a sent poll result through the node queue key', () => {
    const { bridge, commandStore } = makeBridge();

    expect(bridge.confirmCommandHandoff('node-1', 'cmd-1')).toBe(true);
    expect(commandStore.confirmCommandHandoff).toHaveBeenCalledWith(
      'node:node-1',
      'cmd-1',
    );
  });

  it('records remote extension contact on polls and classifies stale nodes', async () => {
    const { bridge, setNow } = makeBridge();

    await bridge.pollCommand('node-1', { timeoutMs: 500 });

    expect(bridge.getLastExtensionContactAt('node-1')).toBe(1_000);
    expect(bridge.isExtensionContactFresh('node-1')).toBe(true);

    setNow(91_001);

    expect(bridge.isExtensionContactFresh('node-1')).toBe(false);
    expect(bridge.describeExtensionContact('node-1')).toMatchObject({
      nodeId: 'node-1',
      lastContactAt: 1_000,
      silent: true,
      staleForMs: 1,
    });
  });

  it('records contact and runtime evidence atomically for the exact remote node', async () => {
    const { bridge, commandStore, contactState } = makeBridge();

    await bridge.pollCommand('node-1', {
      timeoutMs: 500,
      extensionVersion: '0.2.18',
      extensionStartedAt: 1_000,
    });
    expect(commandStore.pollCommand).toHaveBeenLastCalledWith('node:node-1', {
      timeoutMs: 500,
      deferHandoffConfirmation: true,
      allowSecureCredentialCommands: true,
    });
    expect(contactState.getExtensionRuntime('node-1')).toEqual({
      extensionVersion: '0.2.18',
      extensionStartedAt: 1_000,
    });

    await bridge.pollCommand('node-1', {
      timeoutMs: 500,
      extensionStartedAt: 2_000,
    });
    expect(contactState.getExtensionRuntime('node-1')).toEqual({ extensionStartedAt: 2_000 });
  });

  it('logs remote extension poll lost and resumed transitions once per state change', async () => {
    const { bridge, logger, setNow } = makeBridge();

    await bridge.pollCommand('node-1', { timeoutMs: 500 });
    setNow(91_001);

    expect(bridge.isExtensionContactFresh('node-1')).toBe(false);
    expect(bridge.isExtensionContactFresh('node-1')).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Remote browser extension poll lost',
      expect.objectContaining({
        nodeId: 'node-1',
        lastContactAt: 1_000,
        staleForMs: 1,
      }),
    );

    setNow(92_000);
    await bridge.pollCommand('node-1', { timeoutMs: 500 });

    expect(logger.info).toHaveBeenCalledWith(
      'Remote browser extension poll resumed',
      expect.objectContaining({
        nodeId: 'node-1',
        lastContactAt: 92_000,
      }),
    );
  });

  it('suspends node tabs and rejects pending node commands on disconnect', () => {
    const { bridge, commandStore, tabStore, reliabilityEvents } = makeBridge();

    bridge.expireNode('node-1');

    expect(tabStore.suspendNode).toHaveBeenCalledWith('node-1');
    expect(commandStore.rejectQueue).toHaveBeenCalledWith(
      'node:node-1',
      'Remote browser extension node disconnected: node-1',
    );
    expect(reliabilityEvents.record).toHaveBeenCalledWith(
      'node_disconnect',
      expect.objectContaining({
        nodeId: 'node-1',
        detail: { suspendedAttachments: 2 },
      }),
    );
  });

  it('keeps a runtime tombstone across node expiry so delayed polls cannot restore trust', async () => {
    const { bridge, commandStore, contactState } = makeBridge();
    await bridge.pollCommand('node-1', {
      timeoutMs: 500,
      extensionVersion: '0.2.18',
      extensionStartedAt: 2_000,
    });

    bridge.expireNode('node-1');
    await bridge.pollCommand('node-1', {
      timeoutMs: 500,
      extensionVersion: '0.2.18',
      extensionStartedAt: 2_000,
    });

    expect(contactState.getExtensionRuntime('node-1')).toEqual({ extensionStartedAt: 2_000 });
    expect(commandStore.pollCommand).toHaveBeenLastCalledWith('node:node-1', {
      timeoutMs: 500,
      deferHandoffConfirmation: true,
      allowSecureCredentialCommands: false,
    });
  });

  it('restores suspended tabs and records a reconnect when the poll resumes', async () => {
    const { bridge, tabStore, reliabilityEvents, setNow } = makeBridge();
    tabStore.restoreNode.mockReturnValue(2);

    await bridge.pollCommand('node-1', { timeoutMs: 500 });
    setNow(91_001);
    expect(bridge.isExtensionContactFresh('node-1')).toBe(false);
    setNow(92_000);
    await bridge.pollCommand('node-1', { timeoutMs: 500 });

    expect(tabStore.restoreNode).toHaveBeenCalledWith('node-1');
    expect(reliabilityEvents.record).toHaveBeenCalledWith(
      'node_reconnect',
      expect.objectContaining({
        nodeId: 'node-1',
        detail: { restoredAttachments: 2 },
      }),
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
