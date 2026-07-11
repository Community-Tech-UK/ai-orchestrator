import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalReviewToolDefinition } from '../../../review/local-review.types';
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
  outputIds: string[];
  outputMessages: { content: string; accumulatedContent?: string }[];
  complete: boolean;
}

function captureTurnEvents(adapter: OllamaCliAdapter): CapturedTurnEvents {
  const events: CapturedTurnEvents = {
    output: [],
    outputIds: [],
    outputMessages: [],
    complete: false,
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
  const servers: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('normalizes native tool calls and preserves tool-result history', async () => {
    const requests: unknown[] = [];
    const responses = [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            function: {
              name: 'workspace_read',
              arguments: { path: 'README.md' },
            },
          }],
        },
        prompt_eval_count: 7,
        eval_count: 3,
      },
      {
        message: { role: 'assistant', content: 'README looks good.' },
        prompt_eval_count: 12,
        eval_count: 4,
      },
    ];
    const server = await startServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/api/chat') {
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
    const adapter = new OllamaCliAdapter({
      host: '127.0.0.1',
      port: server.port,
      model: 'qwen2.5-coder:14b',
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

    expect(first).toMatchObject({
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
        model: 'qwen2.5-coder:14b',
        stream: false,
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
        model: 'qwen2.5-coder:14b',
        stream: false,
        messages: [
          { role: 'user', content: 'Inspect README.md' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_1',
              function: {
                name: 'workspace_read',
                arguments: { path: 'README.md' },
              },
            }],
          },
          { role: 'tool', tool_name: 'workspace_read', content: '# Project' },
        ],
        tools: expect.any(Array),
      },
    ]);
  });

  it.each([
    ['missing message', {}],
    ['provider error envelope', { error: 'model failed' }],
    ['wrong message role', { message: { role: 'user', content: 'nope' } }],
    ['non-string content', { message: { role: 'assistant', content: 42 } }],
    ['null content without tool calls', { message: { role: 'assistant', content: null } }],
  ])('rejects a malformed HTTP-200 tool response with %s', async (_label, responseBody) => {
    const server = await startServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/api/chat') {
        await readJsonBody(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseBody));
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

    await expect(adapter.sendToolTurn([], [], new AbortController().signal))
      .rejects.toMatchObject({
        name: 'LocalModelToolResponseError',
        code: 'unreliable-tool-response',
      });
  });

  it('accepts null assistant content when a valid tool call is present', async () => {
    const server = await startServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/api/chat') {
        await readJsonBody(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_1',
              function: { name: 'workspace_status', arguments: {} },
            }],
          },
        }));
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

    await expect(adapter.sendToolTurn([], [], new AbortController().signal))
      .resolves.toMatchObject({
        content: '',
        toolCalls: [{ id: 'call_1', name: 'workspace_status', arguments: {} }],
      });
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
    const firstTurnOutputIds = [...events.outputIds];
    const firstTurnOutputMessages = [...events.outputMessages];
    await adapter.sendInput('follow up');
    const secondTurnOutputIds = events.outputIds.slice(firstTurnOutputIds.length);
    const secondTurnOutputMessages = events.outputMessages.slice(firstTurnOutputMessages.length);

    expect(adapter.getEndpointProvider()).toBe('ollama');
    expect(adapter.getModelId()).toBe('qwen2.5-coder:14b');
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
        model: 'qwen2.5-coder:14b',
        stream: true,
        messages: [
          { role: 'system', content: 'Be concise' },
          { role: 'user', content: 'hello' },
        ],
      },
      {
        model: 'qwen2.5-coder:14b',
        stream: true,
        messages: [
          { role: 'system', content: 'Be concise' },
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
          { role: 'user', content: 'follow up' },
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

  it('fails spawn when the requested model is no longer advertised by Ollama', async () => {
    const server = await startServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: '0.7.0' }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'llama3.2:latest' }] }));
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

    await expect(adapter.spawn()).rejects.toThrow(
      'qwen2.5-coder:14b is no longer available from Ollama.',
    );
  });
});
