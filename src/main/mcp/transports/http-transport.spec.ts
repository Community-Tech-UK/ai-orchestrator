import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { HttpTransport } from './http-transport';

describe('HttpTransport', () => {
  let server: http.Server;
  let url: string;
  const received: unknown[] = [];

  beforeEach(async () => {
    received.splice(0);
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        const message = JSON.parse(body) as { id?: number; method?: string };
        received.push(message);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { ok: true, method: message.method },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind test server');
    }
    url = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('posts JSON-RPC messages and emits JSON responses', async () => {
    const transport = new HttpTransport({ url });
    const messages: unknown[] = [];
    transport.on('message', (message) => messages.push(message));
    await transport.connect();
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await transport.disconnect();

    expect(received).toEqual([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 1, result: { ok: true, method: 'ping' } }]);
  });
});
