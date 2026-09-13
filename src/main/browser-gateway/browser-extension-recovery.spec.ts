import { describe, expect, it, vi } from 'vitest';
import { COORDINATOR_TO_NODE } from '../remote-node/worker-node-rpc';
import { BrowserGatewayRpcServer } from './browser-gateway-rpc-server';
import { makeRelayNode, makeService } from './browser-gateway-service.test-helpers';
import { validateBrowserRpcPayload } from './browser-rpc-server-support';

describe('Browser Gateway extension relay recovery', () => {
  it('invokes the service-scoped recovery once and proves a strictly newer healthy contact', async () => {
    const node = makeRelayNode('node-1', 'windows-pc');
    const contactState = sequenceContact([1_000, 1_000, 100_101], 'native_host_stdin_eof');
    const sendServiceRpc = vi.fn().mockResolvedValue(workerRecoveryResult(1_000));
    const extensionCommandStore = { sendCommand: vi.fn() };
    let now = 100_000;
    const { service, driver } = makeService({
      extensionCommandStore,
      extensionContactState: contactState,
      workerNodeRegistry: { getHealthyNodes: () => [node] },
      sendServiceRpc,
      extensionRecoveryNow: () => now,
      extensionRecoveryDelay: async (ms) => { now += ms; },
      extensionRecoveryPollTimeoutMs: 500,
      extensionRecoveryPollIntervalMs: 100,
    });

    const result = await service.recoverExtension({
      instanceId: 'instance-1',
      provider: 'codex',
      computer: 'windows-pc',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: {
        nodeId: 'node-1',
        nodeName: 'windows-pc',
        recoveryStatus: 'recovered',
        elapsedMs: 100,
        before: { silent: true, lastContactAt: 1_000 },
        after: { silent: false, lastContactAt: 100_101 },
      },
    });
    expect(sendServiceRpc).toHaveBeenCalledOnce();
    expect(sendServiceRpc).toHaveBeenCalledWith(
      'node-1',
      COORDINATOR_TO_NODE.BROWSER_EXTENSION_RECOVER,
      {},
    );
    expect(driver.openProfile).not.toHaveBeenCalled();
    expect(driver.navigate).not.toHaveBeenCalled();
    expect(extensionCommandStore.sendCommand).not.toHaveBeenCalled();
  });

  it('keeps the operational deadline open for 36s reconnect backoff plus 10s publication', async () => {
    const node = makeRelayNode('node-1', 'windows-pc');
    let now = 100_000;
    const contactState = {
      getLastExtensionContactAt: vi.fn(() => now >= 146_000 ? 146_000 : 1_000),
      isExtensionContactFresh: vi.fn(() => false),
      describeExtensionContact: vi.fn(() => ({ nodeId: 'node-1', silent: true })),
      getContactGapStats: vi.fn(() => ({ gapCount: 1, longestGapMs: 90_001 })),
      getLastDisconnect: vi.fn(() => ({ at: 999, reason: 'native_host_stdin_eof' })),
    };
    const sendServiceRpc = vi.fn().mockResolvedValue(workerRecoveryResult(1_000));
    const extensionCommandStore = { sendCommand: vi.fn() };
    const { service, driver } = makeService({
      extensionCommandStore,
      extensionContactState: contactState,
      workerNodeRegistry: { getHealthyNodes: () => [node] },
      sendServiceRpc,
      extensionRecoveryNow: () => now,
      extensionRecoveryDelay: async (ms) => { now += ms; },
    });

    const result = await service.recoverExtension({ computer: 'windows-pc' });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: {
        recoveryStatus: 'recovered',
        elapsedMs: 46_000,
        before: { silent: true, lastContactAt: 1_000 },
        after: { silent: false, lastContactAt: 146_000 },
      },
    });
    expect(sendServiceRpc).toHaveBeenCalledOnce();
    expect(driver.openProfile).not.toHaveBeenCalled();
    expect(driver.navigate).not.toHaveBeenCalled();
    expect(extensionCommandStore.sendCommand).not.toHaveBeenCalled();
  });

  it.each([
    { silent: false, reason: 'native_host_stdin_eof' },
    { silent: true, reason: 'extension_port_closed' },
  ])('refuses to bounce a channel outside the recoverable incident: %o', async (incident) => {
    const node = makeRelayNode('node-1', 'windows-pc');
    const sendServiceRpc = vi.fn();
    const now = 100_000;
    const lastContactAt = incident.silent ? 1_000 : now;
    const { service } = makeService({
      extensionContactState: sequenceContact([lastContactAt], incident.reason),
      workerNodeRegistry: { getHealthyNodes: () => [node] },
      sendServiceRpc,
      extensionRecoveryNow: () => now,
    });

    const result = await service.recoverExtension({ computer: 'windows-pc' });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'browser_extension_recovery_incident_not_confirmed',
    });
    expect(sendServiceRpc).not.toHaveBeenCalled();
  });

  it('fails closed when the selected node is local, missing, or has no contact baseline', async () => {
    const node = makeRelayNode('node-1', 'windows-pc');
    const sendServiceRpc = vi.fn();
    const { service: local } = makeService({
      workerNodeRegistry: { getHealthyNodes: () => [node] },
      sendServiceRpc,
    });
    const { service: missing } = makeService({
      workerNodeRegistry: { getHealthyNodes: () => [] },
      sendServiceRpc,
    });
    const { service: noBaseline } = makeService({
      extensionContactState: sequenceContact([undefined], 'native_host_stdin_eof'),
      workerNodeRegistry: { getHealthyNodes: () => [node] },
      sendServiceRpc,
    });

    await expect(local.recoverExtension({ computer: 'local' })).resolves.toMatchObject({
      reason: 'browser_extension_recovery_remote_node_required',
    });
    await expect(missing.recoverExtension({ nodeId: 'node-1' })).resolves.toMatchObject({
      reason: 'browser_extension_recovery_node_unavailable',
    });
    await expect(noBaseline.recoverExtension({ nodeId: 'node-1' })).resolves.toMatchObject({
      reason: 'browser_extension_recovery_contact_baseline_missing',
    });
    expect(sendServiceRpc).not.toHaveBeenCalled();
  });

  it('times out honestly when contact stays silent or does not become strictly newer', async () => {
    const node = makeRelayNode('node-1', 'windows-pc');
    const sendServiceRpc = vi.fn().mockResolvedValue(workerRecoveryResult(1_000));
    let now = 100_000;
    const { service } = makeService({
      extensionContactState: sequenceContact([1_000], 'native_host_stdin_eof'),
      workerNodeRegistry: { getHealthyNodes: () => [node] },
      sendServiceRpc,
      extensionRecoveryNow: () => now,
      extensionRecoveryDelay: async (ms) => { now += ms; },
      extensionRecoveryPollTimeoutMs: 200,
      extensionRecoveryPollIntervalMs: 100,
    });

    const result = await service.recoverExtension({ nodeId: 'node-1' });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: 'browser_extension_recovery_timeout',
      data: {
        recoveryStatus: 'timed_out',
        elapsedMs: 200,
        before: { silent: true, lastContactAt: 1_000 },
        after: { silent: true, lastContactAt: 1_000 },
      },
    });
    expect(sendServiceRpc).toHaveBeenCalledOnce();
  });

  it.each([
    { enabled: true, running: false },
    { enabled: false, running: false },
  ])('does not mistake a stopped relay for recovery: %o', async (relayState) => {
    const beforeNode = makeRelayNode('node-1', 'windows-pc');
    const afterNode = {
      ...beforeNode,
      capabilities: {
        ...beforeNode.capabilities,
        extensionRelay: {
          ...beforeNode.capabilities.extensionRelay!,
          ...relayState,
          lastExtensionContactAt: 100_101,
        },
      },
    };
    let nodeReads = 0;
    const sendServiceRpc = vi.fn().mockResolvedValue(workerRecoveryResult(1_000));
    let now = 100_000;
    const { service } = makeService({
      extensionContactState: sequenceContact([1_000, 100_101], 'native_host_stdin_eof'),
      workerNodeRegistry: {
        getHealthyNodes: () => nodeReads++ === 0 ? [beforeNode] : [afterNode],
      },
      sendServiceRpc,
      extensionRecoveryNow: () => now,
      extensionRecoveryDelay: async (ms) => { now += ms; },
      extensionRecoveryPollTimeoutMs: 200,
      extensionRecoveryPollIntervalMs: 100,
    });

    const result = await service.recoverExtension({ nodeId: 'node-1' });

    expect(result).toMatchObject({
      outcome: 'failed',
      reason: 'browser_extension_recovery_timeout',
      data: {
        recoveryStatus: 'timed_out',
        after: relayState,
      },
    });
    expect(sendServiceRpc).toHaveBeenCalledOnce();
  });

  it('keeps public payload validation strict and routes the exact Browser RPC method', async () => {
    expect(validateBrowserRpcPayload('browser.recover_extension', {
      computer: 'windows-pc',
    })).toEqual({ computer: 'windows-pc' });
    expect(() => validateBrowserRpcPayload('browser.recover_extension', {
      computer: 'windows-pc',
      command: 'node.exec',
    })).toThrow('Invalid browser gateway RPC payload');

    const recoverExtension = vi.fn().mockResolvedValue({ decision: 'allowed' });
    const server = new BrowserGatewayRpcServer({
      service: { recoverExtension },
      userDataPath: '/tmp',
      isKnownLocalInstance: () => true,
      registerCleanup: vi.fn(),
      routeBrowserRequest: (_method, payload) => payload,
    });

    await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'browser.recover_extension',
      params: {
        instanceId: 'instance-1',
        provider: 'codex',
        payload: { computer: 'windows-pc' },
      },
    });

    expect(recoverExtension).toHaveBeenCalledWith({
      instanceId: 'instance-1',
      provider: 'codex',
      computer: 'windows-pc',
    });
  });
});

function sequenceContact(
  contacts: (number | undefined)[],
  disconnectReason: string,
) {
  let index = 0;
  return {
    getLastExtensionContactAt: vi.fn(() => contacts[Math.min(index++, contacts.length - 1)]),
    isExtensionContactFresh: vi.fn(() => false),
    describeExtensionContact: vi.fn(() => ({ nodeId: 'node-1', silent: true })),
    getContactGapStats: vi.fn(() => ({ gapCount: 1, longestGapMs: 90_001 })),
    getLastDisconnect: vi.fn(() => ({ at: 999, reason: disconnectReason })),
  };
}

function workerRecoveryResult(lastContactAt: number) {
  return {
    before: { enabled: true, running: true, lastExtensionContactAt: lastContactAt },
    after: { enabled: true, running: true, lastExtensionContactAt: lastContactAt },
  };
}
