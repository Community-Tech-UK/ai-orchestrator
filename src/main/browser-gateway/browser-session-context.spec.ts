import { describe, expect, it, vi } from 'vitest';
import { BrowserGatewayRpcServer } from './browser-gateway-rpc-server';
import { BrowserExtensionCommandStore } from './browser-extension-command-store';
import { currentBrowserSessionOwner, withBrowserSession } from './browser-session-context';

describe('authenticated browser session command ownership', () => {
  it('preserves tab ownership when the Harness process starts again', async () => {
    const before = withBrowserSession('/tmp', 'SESSION_A_PLACEHOLDER', currentBrowserSessionOwner);
    vi.resetModules();
    const fresh = await import('./browser-session-context');
    expect(fresh.withBrowserSession('/tmp', 'SESSION_A_PLACEHOLDER', fresh.currentBrowserSessionOwner)).toBe(before);
    expect(fresh.withBrowserSession('/tmp/other-harness', 'SESSION_A_PLACEHOLDER', fresh.currentBrowserSessionOwner)).not.toBe(before);
  });
  it('keeps async sessions apart and never exposes a caller outside its scope', async () => {
    const owners = await Promise.all(['SESSION_A_PLACEHOLDER', 'SESSION_B_PLACEHOLDER'].map(instanceId =>
      withBrowserSession('/tmp', instanceId, async () => {
        await Promise.resolve();
        return currentBrowserSessionOwner();
      })));
    expect(owners[0]).toBeTruthy();
    expect(owners[0]).not.toEqual(owners[1]);
    expect(withBrowserSession('/tmp', 'SESSION_A_PLACEHOLDER', currentBrowserSessionOwner)).toBe(owners[0]);
    expect(currentBrowserSessionOwner()).toBeUndefined();
  });

  it('stamps the authenticated RPC owner onto commands instead of accepting a tool-supplied one', async () => {
    const store = new BrowserExtensionCommandStore();
    const snapshot = vi.fn().mockImplementation(async () => store.sendCommand({
      command: 'snapshot', target: { tabId: 7 },
    }));
    const server = new BrowserGatewayRpcServer({
      service: { snapshot }, extensionCommandStore: store, userDataPath: '/tmp',
      isKnownLocalInstance: () => true, registerCleanup: vi.fn(),
      routeBrowserRequest: (_method, payload) => payload,
    });
    const request = (payload: Record<string, unknown>) => server.handleRequest({
      method: 'browser.snapshot', params: { instanceId: 'SESSION_A_PLACEHOLDER', payload },
    });
    const pending = request({ profileId: 'PROFILE_PLACEHOLDER', targetId: 'TARGET_PLACEHOLDER' });
    const command = await store.pollCommand({ timeoutMs: 0, allowSessionClaims: true });
    expect(command?.sessionOwner).toBe(withBrowserSession('/tmp', 'SESSION_A_PLACEHOLDER', currentBrowserSessionOwner));
    store.resolveCommand({ commandId: command!.id, ok: true, result: { done: true } });
    await pending;
    const forged = request({
      profileId: 'PROFILE_PLACEHOLDER', targetId: 'TARGET_PLACEHOLDER', sessionOwner: 'FORGED_OWNER_PLACEHOLDER',
    });
    const second = await store.pollCommand({ timeoutMs: 0, allowSessionClaims: true });
    expect(second?.sessionOwner).toBe(command?.sessionOwner);
    expect(second?.sessionOwner).not.toBe('FORGED_OWNER_PLACEHOLDER');
    store.resolveCommand({ commandId: second!.id, ok: true, result: { done: true } });
    await forged;
    expect(snapshot.mock.calls[1]?.[0]).not.toHaveProperty('sessionOwner');
  });
});
