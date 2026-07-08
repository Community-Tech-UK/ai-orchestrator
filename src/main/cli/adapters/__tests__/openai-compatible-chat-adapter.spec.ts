import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleChatAdapter } from '../openai-compatible-chat-adapter';

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

function captureTurnEvents(adapter: OpenAICompatibleChatAdapter): CapturedTurnEvents {
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
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected server to listen on a TCP port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}

describe('OpenAICompatibleChatAdapter', () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('emits streamed SSE output and completion for sendInput', async () => {
    const requests: unknown[] = [];
    const server = await startServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'qwen2.5-coder-32b-instruct' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        requests.push(await readJsonBody(req));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'there' } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(server);

    const adapter = new OpenAICompatibleChatAdapter({
      baseUrl: server.baseUrl,
      model: 'qwen2.5-coder-32b-instruct',
      systemPrompt: 'Be concise',
    });
    const events = captureTurnEvents(adapter);

    await adapter.spawn();
    await adapter.sendInput('hello');

    expect(adapter.getEndpointProvider()).toBe('openai-compatible');
    expect(adapter.getModelId()).toBe('qwen2.5-coder-32b-instruct');
    expect(events.output.join('')).toContain('hi there');
    expect(events.complete).toBe(true);
    expect(requests).toEqual([
      {
        model: 'qwen2.5-coder-32b-instruct',
        stream: true,
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'Be concise' },
          { role: 'user', content: 'hello' },
        ],
      },
    ]);
  });

  it('falls back to non-streaming chat completions when streaming is unsupported', async () => {
    const requests: unknown[] = [];
    const server = await startServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'qwen2.5-coder-32b-instruct' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const requestBody = await readJsonBody(req);
        requests.push(requestBody);
        if ((requestBody as { stream?: unknown }).stream === true) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'stream is not supported by this endpoint' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'fallback hi' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(server);

    const adapter = new OpenAICompatibleChatAdapter({
      baseUrl: server.baseUrl,
      model: 'qwen2.5-coder-32b-instruct',
    });
    const events = captureTurnEvents(adapter);

    await adapter.spawn();
    await adapter.sendInput('hello');

    expect(events.output.join('')).toContain('fallback hi');
    expect(events.complete).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ stream: true });
    expect(requests[1]).toMatchObject({ stream: false });
  });

  it('enforces the configured timeout while probing endpoint status', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        }, { once: true });
      })
    ));

    const adapter = new OpenAICompatibleChatAdapter({
      baseUrl: 'http://127.0.0.1:1234',
      timeout: 25,
    });

    await expect(adapter.checkStatus()).resolves.toMatchObject({
      available: false,
      error: expect.stringContaining('timed out after 25ms'),
    });
  });

  it('enforces the configured timeout during chat requests', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/v1/models')) {
        return Promise.resolve(new Response(JSON.stringify({
          data: [{ id: 'qwen2.5-coder-32b-instruct' }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }

      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        }, { once: true });
      });
    }));

    const adapter = new OpenAICompatibleChatAdapter({
      baseUrl: 'http://127.0.0.1:1234',
      model: 'qwen2.5-coder-32b-instruct',
      timeout: 25,
    });
    const events = captureTurnEvents(adapter);

    await adapter.spawn();
    await adapter.sendInput('hello');

    expect(events.output.join('')).toContain('timed out after 25ms');
    expect(events.complete).toBe(false);
  });
});
