import * as net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserGatewayRpcServer } from './browser-gateway-rpc-server';
import { BrowserDeviceLoginCapability, setBrowserDeviceLoginCapabilityProvider } from './browser-device-login-capability';
import type { BrowserDeviceLoginOperationController } from './browser-device-login-operation';
import { currentBrowserSessionOwner, withBrowserSession } from './browser-session-context';

const loginHandle = '00000000-0000-4000-8000-000000000001';
const routes = [
  ['start', { nodeId: 'native-node', profileId: 'fresh-profile' }],
  ['read', { loginHandle }],
  ['cancel', { loginHandle }],
  ['fill', { loginHandle, profileId: 'browser-profile', targetId: 'browser-target' }],
] as const;

describe('device-login socket authority and dispatch', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    setBrowserDeviceLoginCapabilityProvider(null);
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'aio-device-rpc-'));
    const capabilities = new BrowserDeviceLoginCapability(id => id === 'owner' || id === 'other');
    setBrowserDeviceLoginCapabilityProvider(capabilities);
    const controller = {
      start: vi.fn<BrowserDeviceLoginOperationController['start']>(),
      read: vi.fn<BrowserDeviceLoginOperationController['read']>(),
      cancel: vi.fn<BrowserDeviceLoginOperationController['cancel']>(),
      fill: vi.fn<BrowserDeviceLoginOperationController['fill']>(),
    };
    const routeBrowserRequest = vi.fn((_method: string, payload: Record<string, unknown>) => payload);
    const server = new BrowserGatewayRpcServer({ service: {}, deviceLoginController: controller,
      userDataPath: directory, isKnownLocalInstance: id => id === 'owner' || id === 'other',
      registerCleanup: () => undefined, routeBrowserRequest });
    cleanups.push(async () => { await server.stop(); rmSync(directory, { recursive: true, force: true }); });
    await server.start();
    const capabilityToken = server.getInstanceCapability('owner');
    const deviceLoginCapabilityToken = capabilities.mint('owner');
    function call(action: string, payload: unknown, token: unknown = deviceLoginCapabilityToken) {
      return new Promise<{ result?: unknown; error?: { message: string } }>((resolve, reject) => {
        const socket = net.connect(server.getSocketPath()!);
        let buffer = '';
        socket.on('error', reject);
        socket.on('connect', () => socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1,
          method: `browser.${action}_device_login`, params: { instanceId: 'owner', capabilityToken,
            deviceLoginCapabilityToken: token, payload } })}\n`));
        socket.on('data', chunk => {
          buffer += chunk.toString();
          if (buffer.includes('\n')) { socket.end(); resolve(JSON.parse(buffer)); }
        });
      });
    }
    return { controller, capabilities, call, routeBrowserRequest, deviceLoginCapabilityToken, directory };
  }

  it.each(routes)('dispatches %s with the authenticated generation only', async (action, payload) => {
    const f = await fixture();
    const response = await f.call(action, payload);
    expect(response.error).toBeUndefined();
    expect(f.controller[action]).toHaveBeenCalledExactlyOnceWith(
      action === 'read' || action === 'cancel' ? loginHandle : payload,
      { sessionId: 'owner', generation: f.capabilities.verify('owner', f.deviceLoginCapabilityToken) },
    );
    expect(f.routeBrowserRequest).not.toHaveBeenCalled();
  });

  it.each(routes)('refuses stale, missing and another session proof for %s before dispatch', async (action, payload) => {
    const f = await fixture();
    f.capabilities.mint('owner');
    for (const token of [null, '', 42, f.deviceLoginCapabilityToken, f.capabilities.mint('other')]) {
      expect(await f.call(action, payload, token)).toMatchObject({ error: { message: 'device_login_request_refused' } });
    }
    expect(f.controller[action]).not.toHaveBeenCalled();
    expect(f.routeBrowserRequest).not.toHaveBeenCalled();
  });

  it.each(routes)('refuses forged %s payload authority without reflecting it', async (action, payload) => {
    const f = await fixture();
    expect(await f.call(action, { ...payload, owner: { sessionId: 'other', generation: 'forged' } }))
      .toMatchObject({ error: { message: 'device_login_request_refused' } });
    expect(f.controller[action]).not.toHaveBeenCalled();
  });

  it('contains controller errors without exposing their contents', async () => {
    const f = await fixture();
    f.controller.read.mockRejectedValue(new Error('NON_SECRET_ERROR_PLACEHOLDER'));
    expect(await f.call('read', { loginHandle })).toMatchObject({ error: { message: 'device_login_request_refused' } });
  });

  it('retains authenticated browser session ownership across controller awaits', async () => {
    const f = await fixture();
    let observed: string | undefined;
    f.controller.read.mockImplementation(async () => {
      await Promise.resolve();
      observed = currentBrowserSessionOwner();
      throw new Error('NON_SECRET_ERROR_PLACEHOLDER');
    });
    await f.call('read', { loginHandle });
    expect(observed).toBe(withBrowserSession(f.directory, 'owner', currentBrowserSessionOwner));
    expect(observed).toBeTruthy();
    expect(currentBrowserSessionOwner()).toBeUndefined();
  });
});
