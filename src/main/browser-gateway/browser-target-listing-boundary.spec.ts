import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import type { BrowserTarget } from '@contracts/types/browser';
import { BrowserGatewayRpcServer } from './browser-gateway-rpc-server';
import { BrowserGatewayRpcClient } from './browser-gateway-rpc-client';
import { registerBrowserGatewayHandlers } from '../ipc/handlers/browser-gateway-handlers';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>(),
  listTargets: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => mocks.handlers.set(channel, handler),
} }));
vi.mock('./browser-gateway-service', () => ({ getBrowserGatewayService: () => ({ listTargets: mocks.listTargets }) }));

function fullTarget(): BrowserTarget {
  return {
    id: 'target-placeholder', targetId: 'target-placeholder', profileId: 'profile-placeholder',
    title: 't'.repeat(200), url: `https://example.test/${'u'.repeat(400)}`,
    origin: 'https://example.test', mode: 'existing-tab', status: 'available',
    inspectionState: 'inspection_unavailable', textUnavailableReason: 'placeholder-unavailable',
    active: false, stale: true, nodeName: 'windows-pc', reboundFromTargetId: 'previous-placeholder',
    pageId: 'page-placeholder', driverTargetId: 'driver-target-placeholder', driver: 'extension',
    windowId: 7, tabIndex: 3, pinned: true, lastSeenAt: 100, lastConfirmedAt: 99,
  };
}

describe('Step 9c listing at serialized RPC versus renderer IPC boundaries', () => {
  let rpc: BrowserGatewayRpcServer;
  let client: BrowserGatewayRpcClient;
  let dir: string;
  const closeTab = vi.fn();
  const ensureTrustedSender = vi.fn((): null | { success: false; error: { code: string; message: string; timestamp: number } } => null);

  beforeEach(async () => {
    mocks.handlers.clear();
    mocks.listTargets.mockReset();
    closeTab.mockReset().mockResolvedValue({ decision: 'denied', outcome: 'not_run', reason: 'destructive_grant_required', auditId: 'close-placeholder' });
    ensureTrustedSender.mockReset().mockReturnValue(null);
    registerBrowserGatewayHandlers({ ensureTrustedSender });
    dir = mkdtempSync(join(tmpdir(), 'aio-list-boundary-'));
    rpc = new BrowserGatewayRpcServer({
      service: { listTargets: mocks.listTargets, closeTab }, userDataPath: dir,
      isKnownLocalInstance: id => ['instance-placeholder', 'other-placeholder'].includes(id),
      registerCleanup: vi.fn(), routeBrowserRequest: (_method, payload) => payload,
    });
    await rpc.start();
    client = rpcClient();
  });
  afterEach(async () => {
    await rpc?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function rpcClient(instanceId = 'instance-placeholder', capabilityToken = rpc.getInstanceCapability(instanceId)!): BrowserGatewayRpcClient {
    return new BrowserGatewayRpcClient({ env: {
      AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: rpc.getSocketPath()!,
      AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: instanceId,
      AI_ORCHESTRATOR_BROWSER_CAPABILITY_TOKEN: capabilityToken,
      AI_ORCHESTRATOR_BROWSER_PROVIDER: 'claude',
    }, timeoutMs: 1_000 });
  }

  function ipcList(payload: unknown = {}): Promise<unknown> {
    const handler = mocks.handlers.get(IPC_CHANNELS.BROWSER_LIST_TARGETS);
    expect(handler).toBeDefined();
    return handler!({}, payload);
  }

  it('projects only RPC tabs, retaining context, marked cuts and close-tool identities while IPC keeps the full records', async () => {
    const target = fullTarget();
    const original = { decision: 'allowed', outcome: 'succeeded', auditId: 'list-placeholder', data: [target] };
    const before = JSON.stringify(original);
    mocks.listTargets.mockResolvedValue(original);
    const compact = await client.call('browser.list_targets', { profileId: target.profileId }) as { data: BrowserTarget[] };
    const expectedTarget = {
      targetId: target.targetId, profileId: target.profileId,
      title: `${target.title!.slice(0, 119)}…`, url: `${target.url!.slice(0, 299)}…`,
      origin: target.origin, mode: target.mode, status: target.status,
      inspectionState: target.inspectionState, active: false, stale: true,
      nodeName: 'windows-pc', textUnavailableReason: target.textUnavailableReason,
      reboundFromTargetId: target.reboundFromTargetId,
    };
    expect(compact).toEqual({ ...original, data: [expectedTarget] });
    expect(mocks.listTargets).toHaveBeenLastCalledWith({
      profileId: target.profileId, instanceId: 'instance-placeholder', provider: 'claude',
    });
    expect(await ipcList({ profileId: target.profileId })).toEqual({ success: true, data: original });
    expect(mocks.listTargets).toHaveBeenLastCalledWith({ profileId: target.profileId });
    expect(JSON.stringify(original)).toBe(before);
    expect(JSON.stringify(compact).length).toBeLessThan(before.length);
    const { profileId, targetId } = compact.data[0];
    await expect(client.call('browser.close_tab', { profileId, targetId })).resolves.toMatchObject({
      decision: 'denied', reason: 'destructive_grant_required',
    });
    expect(closeTab).toHaveBeenCalledExactlyOnceWith({ profileId, targetId, instanceId: 'instance-placeholder', provider: 'claude' });
  });

  it('leaves short context values intact and drops bookkeeping on the actual wire', async () => {
    const target = { ...fullTarget(), title: 'Short title', url: 'https://example.test/page' };
    mocks.listTargets.mockResolvedValue({ decision: 'allowed', outcome: 'succeeded', auditId: 'list-placeholder', data: [target] });
    const result = await client.call('browser.list_targets', {}) as { data: Record<string, unknown>[] };
    expect(result.data[0]).toMatchObject({ title: target.title, url: target.url, targetId: target.targetId, profileId: target.profileId });
    for (const key of ['id', 'pageId', 'driverTargetId', 'driver', 'windowId', 'tabIndex', 'pinned', 'lastSeenAt', 'lastConfirmedAt']) {
      expect(result.data[0]).not.toHaveProperty(key);
    }
    expect(await ipcList()).toEqual({ success: true, data: {
      decision: 'allowed', outcome: 'succeeded', auditId: 'list-placeholder', data: [target],
    } });
  });

  it.each([
    { decision: 'denied', outcome: 'not_run', reason: 'no_grant', auditId: 'denied-placeholder' },
    { decision: 'denied', outcome: 'not_run', reason: 'no_grant', auditId: 'denied-placeholder', data: [] },
    { decision: 'allowed', outcome: 'succeeded', auditId: 'empty-placeholder', data: [] },
  ])('preserves empty/denied envelope $auditId through both boundaries', async result => {
    mocks.listTargets.mockResolvedValue(result);
    expect(await client.call('browser.list_targets', {})).toEqual(result);
    expect(await ipcList()).toEqual({ success: true, data: result });
  });

  it('refuses unknown instances, cross-instance capabilities and invalid listing types before calling the service', async () => {
    await expect(rpcClient('unknown-placeholder', 'PLACEHOLDER_INVALID_CAPABILITY').call('browser.list_targets', {}))
      .resolves.toMatchObject({ decision: 'denied', reason: 'unknown_browser_gateway_instance' });
    await expect(rpcClient('other-placeholder', rpc.getInstanceCapability('instance-placeholder')!).call('browser.list_targets', {}))
      .resolves.toMatchObject({ decision: 'denied', reason: 'invalid_browser_gateway_capability' });
    await expect(client.call('browser.list_targets', { profileId: 42 }))
      .resolves.toMatchObject({ decision: 'denied', reason: 'invalid_browser_gateway_rpc_payload' });
    expect(await ipcList({ profileId: 42 })).toMatchObject({ success: false, error: { code: 'BROWSER_GATEWAY_FAILED' } });
    expect(mocks.listTargets).not.toHaveBeenCalled();
  });

  it('refuses an untrusted renderer before retrieving any full target data', async () => {
    const refusal = { success: false as const, error: { code: 'UNTRUSTED_SENDER', message: 'placeholder refusal', timestamp: 0 } };
    ensureTrustedSender.mockReturnValue(refusal);
    expect(await ipcList()).toEqual(refusal);
    expect(ensureTrustedSender).toHaveBeenCalledWith({}, IPC_CHANNELS.BROWSER_LIST_TARGETS);
    expect(mocks.listTargets).not.toHaveBeenCalled();
  });
});
