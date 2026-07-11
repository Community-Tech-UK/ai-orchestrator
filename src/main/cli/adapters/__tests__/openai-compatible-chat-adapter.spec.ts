import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalReviewToolDefinition } from '../../../review/local-review.types';
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
  outputIds: string[];
  outputMessages: { content: string; accumulatedContent?: string }[];
  complete: boolean;
  error: Error | null;
}

function captureTurnEvents(adapter: OpenAICompatibleChatAdapter): CapturedTurnEvents {
  const events: CapturedTurnEvents = {
    output: [],
    outputIds: [],
    outputMessages: [],
    complete: false,
    error: null,
  };
  adapter.on('output', (message: unknown) => {
    if (typeof message === 'string') {
      events.output.push(message);
      return;
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
      events.output.push(content);
    }
    const id = (message as { id?: unknown }).id;
    if (typeof id === 'string') {
      events.outputIds.push(id);
    }
    if (typeof content === 'string') {
      const accumulatedContent = (message as { metadata?: Record<string, unknown> })
        .metadata?.['accumulatedContent'];
      events.outputMessages.push({
        content,
        ...(typeof accumulatedContent === 'string' ? { accumulatedContent } : {}),
      });
    }
  });
  adapter.on('complete', () => {
    events.complete = true;
  });
  adapter.on('error', (error: Error) => {
    events.error = error;
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
  const servers: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('uses non-streaming tool turns and translates OpenAI tool call IDs', async () => {
    const requests: unknown[] = [];
    const responses = [
      {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: {
                name: 'workspace_read',
                arguments: '{"path":"README.md"}',
              },
            }],
          },
        }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      },
      {
        choices: [{ message: { role: 'assistant', content: 'README looks good.' } }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      },
    ];
    const server = await startServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        requests.push(await readJsonBody(req));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responses.shift()));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(server);

    const tools: readonly LocalReviewToolDefinition[] = [{
      name: 'workspace_read',
      description: 'Read a workspace file.',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' } },
      },
    }];
    const adapter = new OpenAICompatibleChatAdapter({
      baseUrl: server.baseUrl,
      model: 'qwen2.5-coder-32b-instruct',
    });

    const first = await adapter.sendToolTurn(
      [{ role: 'user', content: 'Inspect README.md' }],
      tools,
      new AbortController().signal,
    );
    const second = await adapter.sendToolTurn(
      [
        { role: 'user', content: 'Inspect README.md' },
        { role: 'assistant', content: '', toolCalls: first.toolCalls },
        {
          role: 'tool',
          toolCallId: 'call_1',
          toolName: 'workspace_read',
          content: '# Project',
        },
      ],
      tools,
      new AbortController().signal,
    );

    expect(first).toEqual({
      content: '',
      toolCalls: [{
        id: 'call_1',
        name: 'workspace_read',
        arguments: { path: 'README.md' },
      }],
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    });
    expect(second).toMatchObject({ content: 'README looks good.', toolCalls: [] });
    expect(requests).toEqual([
      {
        model: 'qwen2.5-coder-32b-instruct',
        stream: false,
        temperature: 0.2,
        messages: [{ role: 'user', content: 'Inspect README.md' }],
        tools: [{
          type: 'function',
          function: {
            name: 'workspace_read',
            description: 'Read a workspace file.',
            parameters: tools[0]!.inputSchema,
          },
        }],
      },
      {
        model: 'qwen2.5-coder-32b-instruct',
        stream: false,
        temperature: 0.2,
        messages: [
          { role: 'user', content: 'Inspect README.md' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: {
                name: 'workspace_read',
                arguments: '{"path":"README.md"}',
              },
            }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '# Project' },
        ],
        tools: expect.any(Array),
      },
    ]);
  });

  it('does not start a realm-error fallback fetch when already aborted', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Expected signal to be an instance of AbortSignal'));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort(new Error('review cancelled'));
    const adapter = new OpenAICompatibleChatAdapter({ timeout: 60_000 });

    await expect(adapter.sendToolTurn([], [], controller.signal))
      .rejects.toThrow('review cancelled');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending realm-error fallback and removes abort listeners', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Expected signal to be an instance of AbortSignal'))
      .mockImplementationOnce(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const adapter = new OpenAICompatibleChatAdapter({ timeout: 60_000 });

    const turn = adapter.sendToolTurn([], [], controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    controller.abort(new Error('review cancelled'));

    await expect(turn).rejects.toThrow('review cancelled');
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(clearTimeoutSpy).toHaveBeenCalled();
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
    const firstTurnOutputIds = [...events.outputIds];
    const firstTurnOutputMessages = [...events.outputMessages];
    await adapter.sendInput('follow up');
    const secondTurnOutputIds = events.outputIds.slice(firstTurnOutputIds.length);
    const secondTurnOutputMessages = events.outputMessages.slice(firstTurnOutputMessages.length);

    expect(adapter.getEndpointProvider()).toBe('openai-compatible');
    expect(adapter.getModelId()).toBe('qwen2.5-coder-32b-instruct');
    expect(events.output.join('')).toContain('hi there');
    expect(events.complete).toBe(true);
    expect(new Set(firstTurnOutputIds).size).toBe(1);
    expect(new Set(secondTurnOutputIds).size).toBe(1);
    expect(secondTurnOutputIds[0]).not.toBe(firstTurnOutputIds[0]);
    expect(firstTurnOutputMessages.map((message) => message.accumulatedContent)).toEqual([
      'hi ',
      'hi there',
    ]);
    expect(secondTurnOutputMessages.map((message) => message.accumulatedContent)).toEqual([
      'hi ',
      'hi there',
    ]);
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
      {
        model: 'qwen2.5-coder-32b-instruct',
        stream: true,
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'Be concise' },
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
          { role: 'user', content: 'follow up' },
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

  it('fails spawn when the requested model is no longer advertised by the endpoint', async () => {
    const server = await startServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'llama3.2' }] }));
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

    await expect(adapter.spawn()).rejects.toThrow(
      'qwen2.5-coder-32b-instruct is no longer available from OpenAI-compatible endpoint.',
    );
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
    expect(events.error?.message).toContain('timed out after 25ms');
  });
});
