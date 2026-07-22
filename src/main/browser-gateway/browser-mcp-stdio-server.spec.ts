import { describe, expect, it, vi } from 'vitest';
import type { BrowserGatewayRpcClientLike } from './browser-gateway-rpc-client';
import {
  fetchPreviouslyRevealedToolNames,
  reportToolSurface,
} from './browser-mcp-stdio-server';
import { createBrowserMcpTools } from './browser-mcp-tools';
import {
  BROWSER_GATEWAY_RPC_PROTOCOL_VERSION,
  computeBrowserToolSurfaceHash,
} from './browser-rpc-contract';

describe('fetchPreviouslyRevealedToolNames', () => {
  it('returns the parent-recorded revealed names', async () => {
    const client: BrowserGatewayRpcClientLike = {
      call: vi.fn().mockResolvedValue({
        revealedNames: ['browser.evaluate', 'browser.wait_for'],
      }),
    };
    await expect(fetchPreviouslyRevealedToolNames(client)).resolves.toEqual({
      names: ['browser.evaluate', 'browser.wait_for'],
      restored: true,
      attempts: 1,
    });
    expect(client.call).toHaveBeenCalledWith('browser.tool_reveal_get', {});
  });

  it('degrades to an empty list on a denied/unknown-method response', async () => {
    const client: BrowserGatewayRpcClientLike = {
      call: vi.fn().mockResolvedValue({
        decision: 'denied',
        outcome: 'not_run',
        reason: 'browser_gateway_rpc_error',
      }),
    };
    // A well-formed answer, just not a reveal list: that IS an answer, so it
    // must not be reported as a failed restore.
    await expect(fetchPreviouslyRevealedToolNames(client)).resolves.toMatchObject({
      names: [],
      restored: true,
    });
  });

  it('reports a hung parent as a FAILED restore, not as "nothing was revealed"', async () => {
    const client: BrowserGatewayRpcClientLike = {
      call: vi.fn().mockReturnValue(new Promise(() => undefined)),
    };
    // The distinction that matters: conflating these two made a revealed tool
    // silently vanish from a later execution cell with no diagnostic.
    await expect(fetchPreviouslyRevealedToolNames(client)).resolves.toEqual({
      names: [],
      restored: false,
      attempts: 3,
    });
  }, 20_000);

  it('retries a transiently busy parent instead of dropping the revealed surface', async () => {
    const call = vi.fn()
      .mockRejectedValueOnce(new Error('parent busy'))
      .mockResolvedValueOnce({ revealedNames: ['browser.health'] });
    await expect(fetchPreviouslyRevealedToolNames({ call })).resolves.toEqual({
      names: ['browser.health'],
      restored: true,
      attempts: 2,
    });
  }, 20_000);

  it('filters non-string entries defensively', async () => {
    const client: BrowserGatewayRpcClientLike = {
      call: vi.fn().mockResolvedValue({ revealedNames: ['browser.click', 42, null] }),
    };
    await expect(fetchPreviouslyRevealedToolNames(client)).resolves.toMatchObject({
      names: ['browser.click'],
      restored: true,
    });
  });
});

describe('reportToolSurface', () => {
  it('reports the full tool surface with contract version and hash', async () => {
    const call = vi.fn().mockResolvedValue({});
    reportToolSurface({ call }, ['browser.evaluate']);

    expect(call).toHaveBeenCalledTimes(1);
    const [method, payload] = call.mock.calls[0] as [string, Record<string, unknown>];
    expect(method).toBe('browser.report_tool_surface');
    const expectedTools = createBrowserMcpTools({ call: async () => null });
    expect(payload['names']).toEqual(expectedTools.map((tool) => tool.name));
    expect(payload['revealedNames']).toEqual(['browser.evaluate']);
    expect(payload['protocolVersion']).toBe(BROWSER_GATEWAY_RPC_PROTOCOL_VERSION);
    expect(payload['surfaceHash']).toBe(computeBrowserToolSurfaceHash(expectedTools));
    expect(payload['revealRestoreFailed']).toBeUndefined();
  });

  it('flags a failed reveal restore so browser.health can report the degradation', () => {
    const call = vi.fn().mockResolvedValue({});
    reportToolSurface({ call }, [], { revealRestoreFailed: true });

    const [, payload] = call.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload['revealRestoreFailed']).toBe(true);
  });

  it('swallows report failures (fire-and-forget)', async () => {
    const call = vi.fn().mockRejectedValue(new Error('parent down'));
    expect(() => reportToolSurface({ call }, [])).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });
});
