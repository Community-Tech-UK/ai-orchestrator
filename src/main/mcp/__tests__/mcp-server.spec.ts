import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '../mcp-server';
import type { McpServerToolDefinition } from '../mcp-server-tools';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _setToolOutputDirForTesting } from '../../util/tool-output-truncation';

describe('McpServer', () => {
  beforeEach(() => {
    McpServer._resetForTesting();
  });

  it('handles initialize request', async () => {
    const server = McpServer.getInstance();
    const result = await server.handleRequest({ method: 'initialize', id: 1 });
    expect(result).toHaveProperty('protocolVersion');
    expect(result).toHaveProperty('capabilities');
  });

  it('lists registered tools', async () => {
    const server = McpServer.getInstance();
    server.registerTools(createTestTools());

    const result = await server.handleRequest({ method: 'tools/list', id: 2 }) as { tools: unknown[] };
    expect(result.tools).toHaveLength(1);
  });

  it('calls a tool', async () => {
    const server = McpServer.getInstance();
    const mockListInstances = vi.fn().mockResolvedValue([{ id: 'inst-1' }]);
    server.registerTools(createTestTools(mockListInstances));

    const result = await server.handleRequest({
      method: 'tools/call',
      params: { name: 'orchestrator.list_instances', arguments: {} },
      id: 3,
    }) as { content: { text: string }[] };

    expect(mockListInstances).toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toEqual([{ id: 'inst-1' }]);
  });

  it('emits an MCP image content block for an image-producing tool', async () => {
    const server = McpServer.getInstance();
    // 1x1 PNG (starts with the PNG base64 magic prefix `iVBORw0KGgo`).
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    server.registerTools([{
      name: 'browser.screenshot',
      description: 'test',
      inputSchema: { type: 'object' },
      producesImage: true,
      handler: async () => ({ decision: 'allowed', outcome: 'succeeded', data: pngBase64, auditId: 'a1' }),
    }]);

    const result = await server.handleRequest({
      method: 'tools/call',
      params: { name: 'browser.screenshot', arguments: {} },
      id: 5,
    }) as { content: Array<{ type: string; data?: string; mimeType?: string; text?: string }> };

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: 'image', data: pngBase64, mimeType: 'image/png' });
    expect(result.content[1].type).toBe('text');
    const metadata = JSON.parse(result.content[1].text ?? '{}');
    expect(metadata.outcome).toBe('succeeded');
    expect(metadata.auditId).toBe('a1');
    // The base64 must not be duplicated into the text block.
    expect(metadata.data).not.toContain(pngBase64);
  });

  it('falls back to text for an image-producing tool when no image data is present', async () => {
    const server = McpServer.getInstance();
    server.registerTools([{
      name: 'browser.screenshot',
      description: 'test',
      inputSchema: { type: 'object' },
      producesImage: true,
      handler: async () => ({ decision: 'allowed', outcome: 'failed', data: null, reason: 'boom' }),
    }]);

    const result = await server.handleRequest({
      method: 'tools/call',
      params: { name: 'browser.screenshot', arguments: {} },
      id: 6,
    }) as { content: Array<{ type: string; text?: string }> };

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text ?? '{}').outcome).toBe('failed');
  });

  it('spills a large result and leaves an opted-out result intact', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-mcp-cap-'));
    _setToolOutputDirForTesting(dir);
    try {
      const server = McpServer.getInstance();
      const payload = { blob: 'x'.repeat(40_000) };
      server.registerTools([
        { name: 'bounded', description: '', inputSchema: {}, handler: async () => payload },
        { name: 'evidence', description: '', inputSchema: {}, maxResultChars: null, handler: async () => payload },
      ]);
      const bounded = await server.handleRequest({ method: 'tools/call', params: { name: 'bounded' } }) as { content: Array<{ text: string }> };
      expect(bounded.content[0].text).toContain('saved at');
      expect(bounded.content[0].text).not.toContain('x'.repeat(20_000));
      const spill = fs.readdirSync(dir);
      expect(spill).toHaveLength(1);
      expect(fs.readFileSync(path.join(dir, spill[0]), 'utf8')).toBe(JSON.stringify(payload));
      const full = await server.handleRequest({ method: 'tools/call', params: { name: 'evidence' } }) as { content: Array<{ text: string }> };
      expect(full.content[0].text).toBe(JSON.stringify(payload));
    } finally {
      _setToolOutputDirForTesting(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['no limit override', {}],
    ['an explicit character limit', { maxResultChars: 10 }],
    ['an opted-out limit', { maxResultChars: null }],
    ['a per-call limit resolver', { resolveMaxResultChars: () => 10 }],
    ['the image path', { producesImage: true }],
  ] as const)('answers a handler returning undefined with a text-less block (%s)', async (_label, options) => {
    const server = McpServer.getInstance();
    server.registerTools([{
      name: 'returns-nothing', description: '', inputSchema: {}, ...options, handler: async () => undefined,
    }]);

    const result = await server.handleRequest({ method: 'tools/call', params: { name: 'returns-nothing', arguments: {} } });

    // JSON.stringify(undefined) is undefined; the wire form has always been a type-only text block.
    expect(JSON.stringify(result)).toBe('{"content":[{"type":"text"}]}');
  });

  it('keeps null and falsy results as their JSON text', async () => {
    const server = McpServer.getInstance();
    server.registerTools([
      { name: 'null', description: '', inputSchema: {}, handler: async () => null },
      { name: 'zero', description: '', inputSchema: {}, handler: async () => 0 },
      { name: 'empty', description: '', inputSchema: {}, handler: async () => '' },
    ]);
    const call = (name: string) => server.handleRequest({ method: 'tools/call', params: { name } });

    expect(await call('null')).toEqual({ content: [{ type: 'text', text: 'null' }] });
    expect(await call('zero')).toEqual({ content: [{ type: 'text', text: '0' }] });
    expect(await call('empty')).toEqual({ content: [{ type: 'text', text: '""' }] });
  });

  it('throws on unknown tool', async () => {
    const server = McpServer.getInstance();
    await expect(server.handleRequest({
      method: 'tools/call',
      params: { name: 'nonexistent' },
      id: 4,
    })).rejects.toThrow('Unknown tool');
  });

  it('tracks started/stopped state', () => {
    const server = McpServer.getInstance();
    expect(server.isStarted()).toBe(false);
    server.start();
    expect(server.isStarted()).toBe(true);
    server.stop();
    expect(server.isStarted()).toBe(false);
  });
});

function createTestTools(
  listInstances: () => Promise<unknown[]> = vi.fn(async () => []),
): McpServerToolDefinition[] {
  return [{
    name: 'orchestrator.list_instances',
    description: 'List all running AI instances',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => listInstances(),
  }];
}
