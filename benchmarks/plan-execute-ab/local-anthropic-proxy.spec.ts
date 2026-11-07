import { createServer, request as httpRequest } from 'http';
import type { AddressInfo, Socket } from 'net';
import { describe, expect, it } from 'vitest';
import { isConnectClassError, isRetryableUpstreamError, normalizeBody, startProxy } from './local-anthropic-proxy';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`condition not met within ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

/** An upstream that accepts requests and never answers (a hung generation). */
function pendingUpstream(): Promise<{
  port: number;
  openSockets: () => number;
  requests: () => number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const sockets = new Set<Socket>();
    let requestCount = 0;
    const server = createServer(() => {
      requestCount += 1;
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        openSockets: () => sockets.size,
        requests: () => requestCount,
        close: () => new Promise<void>((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

function proxyPort(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => {
    const check = (): void => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else setTimeout(check, 10);
    };
    check();
  });
}

function post(port: number, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => { text += c.toString('utf8'); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('local anthropic proxy', () => {
  it('lifts trailing in-array system messages into the system field', () => {
    const body = {
      system: [{ type: 'text', text: 'main system' }],
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'system', content: 'context reminder' },
      ],
    };
    const out = normalizeBody(body) as {
      system: { type: string; text: string }[];
      messages: { role: string }[];
    };
    expect(out.messages.map((m) => m.role)).toEqual(['user']);
    expect(out.system.map((s) => s.text)).toEqual(['main system', 'context reminder']);
  });

  it('creates the system field when only in-array system messages exist', () => {
    const body = {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'system', content: [{ type: 'text', text: 'blocky' }] },
      ],
    };
    const out = normalizeBody(body) as { system: { text: string }[]; messages: unknown[] };
    expect(out.messages).toHaveLength(1);
    expect(out.system[0]?.text).toContain('blocky');
  });

  it('leaves requests without in-array system messages untouched', () => {
    const body = { system: [{ type: 'text', text: 's' }], messages: [{ role: 'user', content: 'x' }] };
    const out = normalizeBody(body);
    expect(out).toEqual(body);
  });

  it('preserves the same system prefix when the CLI switches text blocks to a string', () => {
    const request = (content: unknown) => ({
      system: [{ type: 'text', text: 'main system' }],
      messages: [{ role: 'system', content }, { role: 'user', content: 'task' }],
    });
    const text = '# Environment\nWorking directory: /tmp/example';
    expect(normalizeBody(request([{ type: 'text', text }]))).toEqual(normalizeBody(request(text)));
  });

  it('preserves lifted block boundaries and cache metadata without encoding JSON as text', () => {
    const blocks = [
      { type: 'text', text: 'environment' },
      { type: 'text', text: 'reminder', cache_control: { type: 'ephemeral' } },
    ];
    expect(normalizeBody({ messages: [{ role: 'system', content: blocks }] }).system).toEqual(blocks);
  });

  it('classifies connect-level upstream failures as retryable', () => {
    expect(isConnectClassError('connect ETIMEDOUT 100.113.93.104:1234')).toBe(true);
    expect(isConnectClassError('read ETIMEDOUT')).toBe(true);
    expect(isConnectClassError('connect ECONNREFUSED 127.0.0.1:1234')).toBe(true);
    expect(isConnectClassError('socket hang up')).toBe(true);
    expect(isConnectClassError('HTTP 500 from the model')).toBe(false);
    expect(isRetryableUpstreamError('connect deadline after 15000ms')).toBe(true);
    expect(isRetryableUpstreamError('response deadline after 600000ms')).toBe(true);
    expect(isRetryableUpstreamError('HTTP 500 from the model')).toBe(false);
  });

  it('destroys the active upstream request when the client disconnects', async () => {
    // Regression: a killed/timed-out agent run closed the downstream side
    // while the upstream kept generating — orphan inference wedged the server.
    const upstream = await pendingUpstream();
    const proxy = startProxy({
      port: 0,
      upstream: `http://127.0.0.1:${upstream.port}`,
      connectDeadlineMs: 100,
      responseDeadlineMs: 60_000,
      retryDelayMs: 10,
      maxAttempts: 5,
    });
    const port = await proxyPort(proxy);
    try {
      const req = httpRequest(
        { hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json' } },
        (res) => res.resume(),
      );
      req.on('error', () => { /* the client destroy below surfaces as ECONNRESET */ });
      req.write('{}');
      req.end();
      await waitUntil(() => upstream.requests() > 0, 5_000);
      expect(upstream.openSockets()).toBe(1);

      req.destroy();
      await waitUntil(() => upstream.openSockets() === 0, 5_000);
    } finally {
      await upstream.close();
      proxy.close();
    }
  }, 15_000);

  it('destroys a connected upstream that never answers (response deadline)', async () => {
    const upstream = await pendingUpstream();
    const proxy = startProxy({
      port: 0,
      upstream: `http://127.0.0.1:${upstream.port}`,
      connectDeadlineMs: 100,
      responseDeadlineMs: 150,
      retryDelayMs: 10,
      maxAttempts: 0,
    });
    const port = await proxyPort(proxy);
    try {
      const result = await post(port, '{}');
      expect(result.status).toBe(502);
      expect(result.text).toContain('response deadline');
      await waitUntil(() => upstream.openSockets() === 0, 5_000);
    } finally {
      await upstream.close();
      proxy.close();
    }
  }, 15_000);

  it('retries upstream connects until the server appears', async () => {
    const upstreamPort = await freePort();
    const proxy = startProxy({ port: 0, upstream: `http://127.0.0.1:${upstreamPort}`, connectDeadlineMs: 100, retryDelayMs: 50, maxAttempts: 40 });
    const port = await proxyPort(proxy);
    const probe = createServer((_req, res) => res.end('{"ok":true}'));
    setTimeout(() => { probe.listen(upstreamPort, '127.0.0.1'); }, 350);
    const result = await post(port, '{}');
    expect(result.status).toBe(200);
    expect(result.text).toBe('{"ok":true}');
    proxy.close();
    probe.close();
  }, 15_000);

  it('returns 502 once the retry budget is exhausted', async () => {
    const upstreamPort = await freePort();
    const proxy = startProxy({ port: 0, upstream: `http://127.0.0.1:${upstreamPort}`, connectDeadlineMs: 100, retryDelayMs: 10, maxAttempts: 2 });
    const port = await proxyPort(proxy);
    const result = await post(port, '{}');
    expect(result.status).toBe(502);
    expect(result.text).toContain('proxy upstream error');
    proxy.close();
  }, 15_000);
});
