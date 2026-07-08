import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaCliAdapter } from '../ollama-cli-adapter';

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

interface CapturedTurnEvents {
  output: string[];
  complete: boolean;
}

function captureTurnEvents(adapter: OllamaCliAdapter): CapturedTurnEvents {
  const events: CapturedTurnEvents = { output: [], complete: false };
  adapter.on('output', (message: unknown) => {
    if (typeof message === 'string') {
      events.output.push(message);
      return;
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
      events.output.push(content);
    }
  });
  adapter.on('complete', () => {
    events.complete = true;
  });
  return events;
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function startServer(
  handler: http.RequestListener,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected server to listen on a TCP port');
  }
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}

describe('OllamaCliAdapter', () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('emits streamed output and completion for sendInput', async () => {
    const requests: unknown[] = [];
    const server = await startServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/api/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: '0.7.0' }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:14b' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/chat') {
        requests.push(await readJsonBody(req));
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({
          model: 'qwen2.5-coder:14b',
          created_at: '2026-07-08T00:00:00Z',
          message: { role: 'assistant', content: 'hi ' },
          done: false,
        })}\n`);
        res.end(`${JSON.stringify({
          model: 'qwen2.5-coder:14b',
          created_at: '2026-07-08T00:00:01Z',
          message: { role: 'assistant', content: 'there' },
          done: true,
          prompt_eval_count: 4,
          eval_count: 2,
        })}\n`);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(server);

    const adapter = new OllamaCliAdapter({
      host: '127.0.0.1',
      port: server.port,
      model: 'qwen2.5-coder:14b',
      systemPrompt: 'Be concise',
    });
    const events = captureTurnEvents(adapter);

    await adapter.spawn();
    await adapter.sendInput('hello');

    expect(adapter.getEndpointProvider()).toBe('ollama');
    expect(adapter.getModelId()).toBe('qwen2.5-coder:14b');
    expect(events.output.join('')).toContain('hi there');
    expect(events.complete).toBe(true);
    expect(requests).toEqual([
      {
        model: 'qwen2.5-coder:14b',
        stream: true,
        messages: [
          { role: 'system', content: 'Be concise' },
          { role: 'user', content: 'hello' },
        ],
      },
    ]);
  });

  it('rejects attachments so lifecycle fallback can drop them with a warning', async () => {
    const server = await startServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: '0.7.0' }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:14b' }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(server);

    const adapter = new OllamaCliAdapter({
      host: '127.0.0.1',
      port: server.port,
      model: 'qwen2.5-coder:14b',
    });

    await adapter.spawn();

    await expect(adapter.sendInput('inspect this', [
      { name: 'file.txt', type: 'text/plain', size: 5, data: 'aGVsbG8=' },
    ])).rejects.toThrow('Ollama does not currently support attachments in orchestrator mode.');
  });
});
