import { describe, expect, it, vi, beforeEach } from 'vitest';
import { McpServer } from '../mcp/mcp-server';
import {
  BROWSER_CORE_TOOL_NAMES,
  BROWSER_TOOL_DESCRIBE_NAME,
  BROWSER_TOOL_SEARCH_NAME,
  createDeferredBrowserMcpTools,
  measureToolSchemaBytes,
} from './browser-mcp-deferral';
import { createBrowserMcpTools } from './browser-mcp-tools';

describe('browser-mcp-deferral', () => {
  beforeEach(() => {
    McpServer._resetForTesting();
  });

  it('exposes at most 10 visible tool schemas initially (WS9 acceptance)', () => {
    const tools = createDeferredBrowserMcpTools({ call: vi.fn() }, { onReveal: vi.fn() });
    const visible = tools.filter((tool) => !tool.hidden);

    expect(visible.length).toBeLessThanOrEqual(10);
    const visibleNames = visible.map((tool) => tool.name);
    expect(visibleNames).toContain(BROWSER_TOOL_SEARCH_NAME);
    expect(visibleNames).toContain(BROWSER_TOOL_DESCRIBE_NAME);
    for (const core of BROWSER_CORE_TOOL_NAMES) {
      expect(visibleNames).toContain(core);
    }
  });

  it('registers every underlying browser tool for dispatch, hidden or not', () => {
    const tools = createDeferredBrowserMcpTools({ call: vi.fn() }, { onReveal: vi.fn() });
    const underlyingNames = createBrowserMcpTools({ call: vi.fn() }).map((tool) => tool.name);
    const deferredNames = tools.map((tool) => tool.name);

    for (const name of underlyingNames) {
      expect(deferredNames).toContain(name);
    }
  });

  it('keeps underlying tool names, descriptions, and schemas byte-identical to eager mode', () => {
    const eager = createBrowserMcpTools({ call: vi.fn() });
    const deferred = createDeferredBrowserMcpTools({ call: vi.fn() }, { onReveal: vi.fn() });
    const deferredByName = new Map(deferred.map((tool) => [tool.name, tool]));

    for (const tool of eager) {
      const counterpart = deferredByName.get(tool.name);
      expect(counterpart).toBeDefined();
      expect(JSON.stringify({
        name: counterpart!.name,
        description: counterpart!.description,
        inputSchema: counterpart!.inputSchema,
      })).toBe(JSON.stringify({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    }
  });

  it('finds fill_form from "type into a form", returns full schemas, and reveals matches', async () => {
    const onReveal = vi.fn();
    const tools = createDeferredBrowserMcpTools({ call: vi.fn() }, { onReveal });
    const search = tools.find((tool) => tool.name === BROWSER_TOOL_SEARCH_NAME)!;

    const result = (await search.handler({ query: 'type into a form' })) as {
      matches: Array<{ name: string; inputSchema: Record<string, unknown> }>;
    };

    const names = result.matches.map((match) => match.name);
    expect(names).toContain('browser.fill_form');
    const fillForm = result.matches.find((match) => match.name === 'browser.fill_form')!;
    expect(fillForm.inputSchema).toEqual(
      createBrowserMcpTools({ call: vi.fn() })
        .find((tool) => tool.name === 'browser.fill_form')!.inputSchema,
    );
    expect(onReveal).toHaveBeenCalledWith(expect.arrayContaining(['browser.fill_form']));
  });

  it('describe returns one schema and reveals it; unknown names list the catalogue', async () => {
    const onReveal = vi.fn();
    const tools = createDeferredBrowserMcpTools({ call: vi.fn() }, { onReveal });
    const describeTool = tools.find((tool) => tool.name === BROWSER_TOOL_DESCRIBE_NAME)!;

    const known = (await describeTool.handler({ name: 'browser.wait_for' })) as {
      name: string;
      inputSchema: Record<string, unknown>;
    };
    expect(known.name).toBe('browser.wait_for');
    expect(known.inputSchema).toBeDefined();
    expect(onReveal).toHaveBeenCalledWith(['browser.wait_for']);

    const unknown = (await describeTool.handler({ name: 'browser.nope' })) as {
      error: string;
      availableTools: string[];
    };
    expect(unknown.error).toContain('browser.nope');
    expect(unknown.availableTools).toContain('browser.fill_form');
  });

  it('search→call round-trip: a deferred tool executes through the RPC client', async () => {
    const call = vi.fn().mockResolvedValue({ decision: 'allowed' });
    const server = McpServer.getInstance();
    server.registerTools(
      createDeferredBrowserMcpTools({ call }, { onReveal: (names) => server.revealTools(names) }),
    );

    const initialList = (await server.handleRequest({ method: 'tools/list' })) as {
      tools: Array<{ name: string }>;
    };
    expect(initialList.tools.map((tool) => tool.name)).not.toContain('browser.fill_form');

    const listChanged = vi.fn();
    server.on('tools-list-changed', listChanged);
    await server.handleRequest({
      method: 'tools/call',
      params: { name: BROWSER_TOOL_SEARCH_NAME, arguments: { query: 'fill a form' } },
    });
    expect(listChanged).toHaveBeenCalled();

    const revealedList = (await server.handleRequest({ method: 'tools/list' })) as {
      tools: Array<{ name: string }>;
    };
    expect(revealedList.tools.map((tool) => tool.name)).toContain('browser.fill_form');

    await server.handleRequest({
      method: 'tools/call',
      params: {
        name: 'browser.fill_form',
        arguments: { profileId: 'p1', targetId: 't1', fields: [] },
      },
    });
    expect(call).toHaveBeenCalledWith('browser.fill_form', {
      profileId: 'p1',
      targetId: 't1',
      fields: [],
    });
  });

  it('a hidden tool is still callable before any reveal (schema known out-of-band)', async () => {
    const call = vi.fn().mockResolvedValue({ decision: 'allowed' });
    const server = McpServer.getInstance();
    server.registerTools(
      createDeferredBrowserMcpTools({ call }, { onReveal: (names) => server.revealTools(names) }),
    );

    await server.handleRequest({
      method: 'tools/call',
      params: { name: 'browser.health', arguments: {} },
    });
    expect(call).toHaveBeenCalledWith('browser.health', {});
  });

  it('deferred visible schema bytes are a fraction of the full surface', () => {
    const full = createBrowserMcpTools({ call: vi.fn() });
    const deferred = createDeferredBrowserMcpTools({ call: vi.fn() }, { onReveal: vi.fn() });
    const visibleBytes = measureToolSchemaBytes(deferred.filter((tool) => !tool.hidden));
    const fullBytes = measureToolSchemaBytes(full);

    expect(visibleBytes).toBeGreaterThan(0);
    expect(visibleBytes).toBeLessThan(fullBytes / 2);
  });
});
