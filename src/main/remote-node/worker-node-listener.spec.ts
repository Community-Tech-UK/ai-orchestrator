import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocketServer } from 'ws';

const tls = vi.hoisted(() => ({ servers: [] as unknown[], files: new Map<string, string>() }));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync: (file: string, ...rest: unknown[]) =>
    tls.files.has(file) ? tls.files.get(file) : (actual.readFileSync as (...a: unknown[]) => unknown)(file, ...rest) };
});

vi.mock('https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('https')>();
  return {
    ...actual,
    createServer: vi.fn((options: unknown) => {
      // A bare event emitter is enough: `ws` only needs `on` for a shared server.
      const server = Object.assign(new EventEmitter(), {
        options,
        listen: vi.fn(),
        address: () => null,
      });
      tls.servers.push(server);
      return server;
    }),
  };
});

import { listenWorkerNodeServer } from './worker-node-listener';

type FakeHttps = EventEmitter & { options: Record<string, unknown>; listen: ReturnType<typeof vi.fn> };

describe('listenWorkerNodeServer', () => {
  const open: WebSocketServer[] = [];

  afterEach(async () => {
    await Promise.all(open.map((wss) => new Promise((resolve) => wss.close(resolve))));
    open.length = 0;
    tls.servers.length = 0;
    tls.files.clear();
  });

  it('listens with plain WebSocket when no certificate is configured', async () => {
    const wss = await listenWorkerNodeServer({ port: 0, host: '127.0.0.1', config: {}, isRunning: () => false });
    open.push(wss);
    expect((wss.address() as AddressInfo).port).toBeGreaterThan(0);
    expect(tls.servers).toHaveLength(0);
  });

  it('rejects when the port is taken, before the server counts as running', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as AddressInfo).port;
    try {
      await expect(
        listenWorkerNodeServer({ port, host: '127.0.0.1', config: {}, isRunning: () => false }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('uses an HTTPS server with the certificate and key, and the CA to require client certificates', async () => {
    tls.files.set('/tls/cert.pem', 'CERT');
    tls.files.set('/tls/key.pem', 'KEY');
    tls.files.set('/tls/ca.pem', 'CA');
    const pending = listenWorkerNodeServer({
      port: 4878,
      host: '::',
      config: { tlsCertPath: '/tls/cert.pem', tlsKeyPath: '/tls/key.pem', tlsCaPath: '/tls/ca.pem' },
      isRunning: () => false,
    });
    const server = tls.servers[0] as FakeHttps;
    expect(server.options).toMatchObject({
      cert: 'CERT', key: 'KEY', ca: 'CA', requestCert: true, rejectUnauthorized: true,
    });
    expect(server.listen).toHaveBeenCalledWith(4878, '::', expect.any(Function));
    (server.listen.mock.calls[0][2] as () => void)();
    await expect(pending).resolves.toBeDefined();
  });

  it('omits client-certificate checks without a CA', async () => {
    tls.files.set('/tls/cert.pem', 'CERT');
    tls.files.set('/tls/key.pem', 'KEY');
    const pending = listenWorkerNodeServer({
      port: 4878,
      host: '0.0.0.0',
      config: { tlsCertPath: '/tls/cert.pem', tlsKeyPath: '/tls/key.pem' },
      isRunning: () => false,
    });
    const server = tls.servers[0] as FakeHttps;
    expect(server.options).not.toHaveProperty('requestCert');
    (server.listen.mock.calls[0][2] as () => void)();
    await expect(pending).resolves.toBeDefined();
  });
  it('rejects a TLS listen failure instead of throwing it', async () => {
    tls.files.set('/tls/cert.pem', 'CERT');
    tls.files.set('/tls/key.pem', 'KEY');
    const pending = listenWorkerNodeServer({
      port: 4878,
      host: '::',
      config: { tlsCertPath: '/tls/cert.pem', tlsKeyPath: '/tls/key.pem' },
      isRunning: () => false,
    });
    const server = tls.servers[0] as FakeHttps;
    const error = Object.assign(new Error('listen EAFNOSUPPORT'), { code: 'EAFNOSUPPORT' });

    expect(() => server.emit('error', error)).not.toThrow();
    await expect(pending).rejects.toBe(error);
  });
});
