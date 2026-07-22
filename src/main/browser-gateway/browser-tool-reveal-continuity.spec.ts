import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '../mcp/mcp-server';
import {
  BROWSER_TOOL_SEARCH_NAME,
  createDeferredBrowserMcpTools,
} from './browser-mcp-deferral';
import { fetchPreviouslyRevealedToolNames } from './browser-mcp-stdio-server';
import {
  BrowserToolRevealStore,
  getBrowserToolRevealStore,
} from './browser-tool-reveal-store';

/**
 * Reveal continuity across execution cells and a forced bridge reconnect.
 *
 * The failure this covers: `browser.tool_search` revealed `browser.health` in
 * one execution cell, and in the next cell the tool was absent from the listed
 * surface — discovery was effectively useless. Reveal state lives in the PARENT
 * keyed by instanceId, and a restarted forwarder restores it before its first
 * `tools/list`.
 */

const INSTANCE_ID = 'instance-continuity';

/**
 * One forwarder process. Re-creating it models a bridge reconnect: a brand new
 * McpServer with an empty in-process reveal set, restoring from the parent.
 */
async function startForwarder(parent: { call: ReturnType<typeof vi.fn> }) {
  McpServer._resetForTesting();
  const server = McpServer.getInstance();
  server.registerTools(
    createDeferredBrowserMcpTools(parent, {
      onReveal: (names) => {
        server.revealTools(names);
        void parent.call('browser.tool_reveal_record', { names });
      },
    }),
  );
  const restore = await fetchPreviouslyRevealedToolNames(parent);
  if (restore.names.length > 0) {
    server.revealTools(restore.names);
  }
  return { server, restore };
}

function listedToolNames(server: McpServer): Promise<string[]> {
  return server
    .handleRequest({ method: 'tools/list', id: 1 })
    .then((result) => {
      const tools = (result as { tools: Array<{ name: string }> }).tools;
      return tools.map((tool) => tool.name);
    });
}

describe('browser tool reveal continuity', () => {
  beforeEach(() => {
    McpServer._resetForTesting();
    BrowserToolRevealStore._resetForTesting();
  });

  /** A parent that persists reveals exactly like BrowserGatewayRpcServer does. */
  function makeParent() {
    const store = getBrowserToolRevealStore();
    return {
      call: vi.fn(async (method: string, payload?: Record<string, unknown>) => {
        if (method === 'browser.tool_reveal_record') {
          store.recordRevealed(INSTANCE_ID, (payload?.['names'] as string[]) ?? []);
          return { ok: true };
        }
        if (method === 'browser.tool_reveal_get') {
          return { revealedNames: store.getRevealed(INSTANCE_ID) };
        }
        return { ok: true };
      }),
    };
  }

  it('keeps a tool revealed in cell A listed in cell B and after a bridge reconnect', async () => {
    const parent = makeParent();

    // Cell A: discover and reveal browser.health.
    const { server: cellA } = await startForwarder(parent);
    expect(await listedToolNames(cellA)).not.toContain('browser.health');

    await cellA.handleRequest({
      method: 'tools/call',
      id: 2,
      params: { name: BROWSER_TOOL_SEARCH_NAME, arguments: { query: 'health' } },
    });
    expect(await listedToolNames(cellA)).toContain('browser.health');

    // Cell B: same forwarder, later call — still listed.
    expect(await listedToolNames(cellA)).toContain('browser.health');

    // Forced bridge reconnect: a brand new forwarder process.
    const { server: cellC, restore } = await startForwarder(parent);
    expect(restore.restored).toBe(true);
    expect(restore.names).toContain('browser.health');

    // Cell C: the surface is identical to before the reconnect.
    expect(await listedToolNames(cellC)).toContain('browser.health');
  });

  it('keeps a revealed tool dispatchable even when the reveal list is lost', async () => {
    // A hidden tool is a LISTING state, never a capability state: losing the
    // reveal must cost visibility only, so an agent that remembers the name can
    // still call it rather than being told it does not exist.
    const parent = makeParent();
    const { server } = await startForwarder(parent);

    expect(await listedToolNames(server)).not.toContain('browser.health');
    const result = await server.handleRequest({
      method: 'tools/call',
      id: 3,
      params: { name: 'browser.health', arguments: {} },
    });

    expect(result).toBeDefined();
    expect(parent.call).toHaveBeenCalledWith('browser.health', expect.anything());
  });

  it('does not wipe the parent record when a forwarder starts with a hung parent', async () => {
    const store = getBrowserToolRevealStore();
    store.recordRevealed(INSTANCE_ID, ['browser.health']);
    const hungParent = { call: vi.fn().mockReturnValue(new Promise(() => undefined)) };

    const { restore } = await startForwarder(hungParent);

    expect(restore.restored).toBe(false);
    // The parent is the source of truth and stays intact, so the next
    // forwarder start recovers the full surface.
    expect(store.getRevealed(INSTANCE_ID)).toEqual(['browser.health']);
  }, 20_000);
});
