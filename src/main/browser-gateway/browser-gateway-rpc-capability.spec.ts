import * as net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const access = vi.hoisted(() => ({
  request: vi.fn(async () => ({ decision: 'requires_user', requestId: 'PLACEHOLDER_REQUEST' })),
  status: vi.fn(async () => ({ decision: 'allowed', data: { status: 'approved' } })),
  cancel: vi.fn(async () => ({ decision: 'allowed', data: { status: 'denied' } })),
}));
vi.mock('./browser-credential-access-service', () => ({ getBrowserCredentialAccessService: () => access }));
import { BrowserGatewayRpcServer } from './browser-gateway-rpc-server';
import { BrowserToolRevealStore } from './browser-tool-reveal-store';
import type { BrowserGatewayService } from './browser-gateway-service';

const routes = [
  ['browser.request_credential_access', { profileId: 'PLACEHOLDER_PROFILE', targetId: 'PLACEHOLDER_TARGET', item: 'Saved test login', reason: 'Test task' }],
  ['browser.get_credential_access_status', { requestId: 'PLACEHOLDER_REQUEST' }],
  ['browser.cancel_credential_access', { requestId: 'PLACEHOLDER_REQUEST' }],
  ['browser.fill_credential', { profileId: 'PLACEHOLDER_PROFILE', targetId: 'PLACEHOLDER_TARGET', vaultItemRef: 'PLACEHOLDER_ITEM', fields: [{ selector: '#username', kind: 'username' }] }],
  ['browser.tool_reveal_get', {}],
] as const;

describe('Browser Gateway socket session ownership', () => {
  const servers: BrowserGatewayRpcServer[] = [];
  const directories: string[] = [];
  beforeEach(() => vi.clearAllMocks());
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
  });

  async function startServer() {
    const directory = mkdtempSync(join(tmpdir(), 'aio-browser-ownership-'));
    directories.push(directory);
    const fillCredential = vi.fn<BrowserGatewayService['fillCredential']>(async () => ({
      decision: 'allowed', outcome: 'succeeded', auditId: 'PLACEHOLDER_AUDIT', data: { filled: 1 },
    }));
    const routeBrowserRequest = vi.fn((_method: string, payload: Record<string, unknown>) => payload);
    const knownInstances = new Set(['PLACEHOLDER_A', 'PLACEHOLDER_B']);
    const server = new BrowserGatewayRpcServer({
      service: { fillCredential }, userDataPath: directory,
      isKnownLocalInstance: (id) => knownInstances.has(id),
      registerCleanup: () => undefined, routeBrowserRequest,
      toolRevealStore: new BrowserToolRevealStore(),
      extensionToken: 'PLACEHOLDER_EXTENSION_TOKEN',
    });
    servers.push(server);
    await server.start();
    return { server, fillCredential, routeBrowserRequest, knownInstances };
  }

  function call(server: BrowserGatewayRpcServer, method: string, params: Record<string, unknown>) {
    return new Promise<{ result?: unknown; error?: { message: string } }>((resolve, reject) => {
      const socket = net.connect(server.getSocketPath()!);
      let buffer = '';
      socket.on('error', reject);
      socket.on('connect', () => socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`));
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes('\n')) {
          socket.end();
          resolve(JSON.parse(buffer));
        }
      });
    });
  }

  it('rejects a claimed saved-login owner without session proof before cancellation dispatch', async () => {
    const { server, routeBrowserRequest } = await startServer();
    const response = await call(server, 'browser.cancel_credential_access', {
      instanceId: 'PLACEHOLDER_B', payload: { requestId: 'PLACEHOLDER_REQUEST' },
    });
    expect(response.error?.message).toBe('invalid or missing browser gateway capability token');
    expect(access.cancel).not.toHaveBeenCalled();
    expect(routeBrowserRequest).not.toHaveBeenCalled();
  });

  it.each(routes)('authenticates %s before dispatch, including missing and cross-session proof', async (method, payload) => {
    const { server, fillCredential, routeBrowserRequest } = await startServer();
    const wrongOwner = server.getInstanceCapability('PLACEHOLDER_A')!;
    for (const capabilityToken of [undefined, '', 'PLACEHOLDER_INVALID_CAPABILITY', wrongOwner, 42]) {
      const response = await call(server, method, { instanceId: 'PLACEHOLDER_B', capabilityToken, payload });
      expect(response).toMatchObject({ error: { message: 'invalid or missing browser gateway capability token' } });
      expect(response.result).toBeUndefined();
    }
    expect(access.request).not.toHaveBeenCalled();
    expect(access.status).not.toHaveBeenCalled();
    expect(access.cancel).not.toHaveBeenCalled();
    expect(fillCredential).not.toHaveBeenCalled();
    expect(routeBrowserRequest).not.toHaveBeenCalled();
  });

  it.each(routes)('dispatches authenticated %s with only its session context', async (method, payload) => {
    const { server, routeBrowserRequest, fillCredential } = await startServer();
    const capabilityToken = server.getInstanceCapability('PLACEHOLDER_B')!;
    const response = await call(server, method, { instanceId: 'PLACEHOLDER_B', capabilityToken, payload });
    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();
    expect(JSON.stringify(response).includes(capabilityToken)).toBe(false);
    expect(routeBrowserRequest).toHaveBeenCalledOnce();
    if (method === 'browser.cancel_credential_access') {
      expect(access.cancel).toHaveBeenCalledWith('PLACEHOLDER_REQUEST', { instanceId: 'PLACEHOLDER_B', provider: undefined });
    }
    if (method === 'browser.fill_credential') {
      expect(fillCredential).toHaveBeenCalledWith({ ...payload, instanceId: 'PLACEHOLDER_B' });
    }
  });

  it('rejects capabilities from a prior browser server lifetime', async () => {
    const previous = await startServer();
    const capabilityToken = previous.server.getInstanceCapability('PLACEHOLDER_B')!;
    const current = await startServer();
    const response = await call(current.server, 'browser.cancel_credential_access', {
      instanceId: 'PLACEHOLDER_B', capabilityToken, payload: { requestId: 'PLACEHOLDER_REQUEST' },
    });
    expect(response.error?.message).toBe('invalid or missing browser gateway capability token');
    expect(access.cancel).not.toHaveBeenCalled();
  });

  it('never mints capabilities for unknown sessions', async () => {
    const { server } = await startServer();
    expect(server.getInstanceCapability('PLACEHOLDER_UNKNOWN')).toBeNull();
  });

  it('rejects a valid capability once its session is removed', async () => {
    const { server, knownInstances } = await startServer();
    const capabilityToken = server.getInstanceCapability('PLACEHOLDER_B')!;
    knownInstances.delete('PLACEHOLDER_B');
    const response = await call(server, 'browser.cancel_credential_access', {
      instanceId: 'PLACEHOLDER_B', capabilityToken, payload: { requestId: 'PLACEHOLDER_REQUEST' },
    });
    expect(response.error?.message).toBe('unknown browser gateway instance');
    expect(access.cancel).not.toHaveBeenCalled();
  });

  it('retains authenticated tool reveal continuity across forwarder reconnects', async () => {
    const { server } = await startServer();
    const capabilityToken = server.getInstanceCapability('PLACEHOLDER_B')!;
    expect(await call(server, 'browser.tool_reveal_record', {
      instanceId: 'PLACEHOLDER_B', capabilityToken, payload: { names: ['browser_fill_credential'] },
    })).toMatchObject({ result: { ok: true } });
    expect(await call(server, 'browser.tool_reveal_get', {
      instanceId: 'PLACEHOLDER_B', capabilityToken, payload: {},
    })).toMatchObject({ result: { revealedNames: ['browser_fill_credential'] } });
  });

  it('rejects forged credential fill payload identity even with valid session proof', async () => {
    const { server, fillCredential } = await startServer();
    const capabilityToken = server.getInstanceCapability('PLACEHOLDER_A')!;
    const payload = { ...routes[3][1], instanceId: 'PLACEHOLDER_B', provider: 'forged-provider' };
    const response = await call(server, 'browser.fill_credential', {
      instanceId: 'PLACEHOLDER_A', capabilityToken, provider: 'codex', payload,
    });
    expect(response.error?.message).toBe('Invalid browser gateway RPC payload');
    expect(fillCredential).not.toHaveBeenCalled();
    expect(JSON.stringify(response).includes(capabilityToken)).toBe(false);
  });

  it('rejects extra saved-login identity parameters even with valid session proof', async () => {
    const { server } = await startServer();
    const capabilityToken = server.getInstanceCapability('PLACEHOLDER_A')!;
    const response = await call(server, 'browser.request_credential_access', {
      instanceId: 'PLACEHOLDER_A', capabilityToken,
      payload: { ...routes[0][1], instanceId: 'PLACEHOLDER_B' },
    });
    expect(response.error?.message).toBe('Invalid browser gateway RPC payload');
    expect(access.request).not.toHaveBeenCalled();
    expect(JSON.stringify(response).includes(capabilityToken)).toBe(false);
  });

  it('retains independent native-host extension authentication', async () => {
    const { server } = await startServer();
    const payload = { reason: 'PLACEHOLDER_DISCONNECT' };
    expect(await call(server, 'browser.extension_disconnected', {
      extensionToken: 'PLACEHOLDER_EXTENSION_TOKEN', payload,
    })).toMatchObject({ result: { ok: true } });
    expect(await call(server, 'browser.extension_disconnected', {
      extensionToken: 'PLACEHOLDER_INVALID_EXTENSION_TOKEN', payload,
    })).toMatchObject({ error: { message: 'invalid browser extension host token' } });
  });
});
