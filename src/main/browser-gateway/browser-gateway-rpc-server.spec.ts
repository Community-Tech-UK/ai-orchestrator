import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BrowserGatewayRpcServer } from './browser-gateway-rpc-server';

describe('BrowserGatewayRpcServer', () => {
  it('rejects unknown instance ids before reaching the gateway', async () => {
    const navigate = vi.fn();
    const server = new BrowserGatewayRpcServer({
      service: { navigate },
      userDataPath: '/tmp',
      isKnownLocalInstance: () => false,
      registerCleanup: vi.fn(),
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'browser.navigate',
        params: {
          instanceId: 'unknown',
          payload: {
            profileId: 'profile-1',
            targetId: 'target-1',
            url: 'http://localhost:4567',
          },
        },
      }),
    ).rejects.toThrow(/unknown browser gateway instance/);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('rejects instance ids by default unless the app supplies a known-instance validator', async () => {
    const navigate = vi.fn();
    const server = new BrowserGatewayRpcServer({
      service: { navigate },
      userDataPath: '/tmp',
      registerCleanup: vi.fn(),
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'browser.navigate',
        params: {
          instanceId: 'instance-1',
          payload: {
            profileId: 'profile-1',
            targetId: 'target-1',
            url: 'http://localhost:4567',
          },
        },
      }),
    ).rejects.toThrow(/unknown browser gateway instance/);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('rejects oversized payloads', async () => {
    const server = new BrowserGatewayRpcServer({
      service: { navigate: vi.fn() },
      userDataPath: '/tmp',
      isKnownLocalInstance: () => true,
      registerCleanup: vi.fn(),
      maxPayloadBytes: 10,
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'browser.navigate',
        params: {
          instanceId: 'instance-1',
          payload: {
            profileId: 'profile-1',
            targetId: 'target-1',
            url: 'http://localhost:4567/too-large',
          },
        },
      }),
    ).rejects.toThrow(/payload too large/);
  });

  it('rejects invalid schemas and forwards valid calls', async () => {
    const navigate = vi.fn().mockResolvedValue({ decision: 'allowed' });
    const server = new BrowserGatewayRpcServer({
      service: { navigate },
      userDataPath: '/tmp',
      isKnownLocalInstance: () => true,
      registerCleanup: vi.fn(),
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'browser.navigate',
        params: {
          instanceId: 'instance-1',
          payload: {
            profileId: 'profile-1',
          },
        },
      }),
    ).rejects.toThrow(/Invalid browser gateway RPC payload/);

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'browser.navigate',
        params: {
          instanceId: 'instance-1',
          payload: {
            profileId: 'profile-1',
            targetId: 'target-1',
            url: 'http://localhost:4567',
          },
        },
      }),
    ).resolves.toEqual({ decision: 'allowed' });
    expect(navigate).toHaveBeenCalledWith({
      instanceId: 'instance-1',
      profileId: 'profile-1',
      targetId: 'target-1',
      url: 'http://localhost:4567',
    });
  });

  it('validates and forwards mutating browser gateway calls', async () => {
    const click = vi.fn().mockResolvedValue({ decision: 'requires_user', requestId: 'request-1' });
    const server = new BrowserGatewayRpcServer({
      service: { click },
      userDataPath: '/tmp',
      isKnownLocalInstance: () => true,
      registerCleanup: vi.fn(),
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'browser.click',
        params: {
          instanceId: 'instance-1',
          payload: {
            profileId: 'profile-1',
            targetId: 'target-1',
            selector: 'button.publish',
          },
        },
      }),
    ).resolves.toEqual({ decision: 'requires_user', requestId: 'request-1' });
    expect(click).toHaveBeenCalledWith({
      instanceId: 'instance-1',
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.publish',
    });
  });

  it('falls back to a short temp socket path when userData is too long for Unix sockets', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const longUserDataPath = path.join(
      os.tmpdir(),
      'browser-gateway-rpc-server-spec',
      'a'.repeat(140),
    );
    fs.mkdirSync(longUserDataPath, { recursive: true });
    const server = new BrowserGatewayRpcServer({
      service: {},
      userDataPath: longUserDataPath,
      isKnownLocalInstance: () => true,
      registerCleanup: vi.fn(),
    });

    await server.start();
    const socketPath = server.getSocketPath();

    expect(socketPath).toBeTruthy();
    expect(socketPath).not.toContain(longUserDataPath);
    expect(Buffer.byteLength(socketPath!, 'utf-8')).toBeLessThanOrEqual(100);

    await server.stop();
  });

  it('returns a JSON-RPC error for malformed socket input', async () => {
    const server = new BrowserGatewayRpcServer({
      service: {},
      userDataPath: os.tmpdir(),
      isKnownLocalInstance: () => true,
      registerCleanup: vi.fn(),
    });

    await server.start();
    try {
      const response = await sendRaw(server.getSocketPath()!, '{not-json}\n');

      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: null,
        error: {
          message: 'Invalid Browser Gateway RPC request JSON',
        },
      });
    } finally {
      await server.stop();
    }
  });

  it('rejects raw socket requests that exceed the configured envelope limit', async () => {
    const server = new BrowserGatewayRpcServer({
      service: {},
      userDataPath: os.tmpdir(),
      isKnownLocalInstance: () => true,
      registerCleanup: vi.fn(),
      maxPayloadBytes: 1,
    });

    await server.start();
    try {
      const response = await sendRaw(
        server.getSocketPath()!,
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'browser.health',
          params: {
            instanceId: 'instance-1',
            payload: {
              value: 'x'.repeat(20_000),
            },
          },
        })}\n`,
      );

      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: null,
        error: {
          message: 'Browser Gateway RPC request too large',
        },
      });
    } finally {
      await server.stop();
    }
  });
});

function sendRaw(socketPath: string, raw: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    socket.on('connect', () => {
      socket.write(raw);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
    });
    socket.on('end', () => {
      try {
        resolve(JSON.parse(buffer.trim()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', reject);
  });
}
