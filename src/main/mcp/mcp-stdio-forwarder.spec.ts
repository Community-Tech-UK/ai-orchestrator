import { describe, expect, it, vi } from 'vitest';
import { dispatchStdioMcpRequest } from './mcp-stdio-forwarder';

type StdioServer = Parameters<typeof dispatchStdioMcpRequest>[0];

function createServer(implementation?: StdioServer['handleRequest']) {
  const handleRequest = vi.fn<StdioServer['handleRequest']>(
    implementation ?? (async () => ({ ok: true })),
  );
  return {
    server: { handleRequest },
    handleRequest,
  };
}

describe('dispatchStdioMcpRequest', () => {
  it('handles shutdown in the stdio protocol layer', async () => {
    const { server, handleRequest } = createServer();

    const result = await dispatchStdioMcpRequest(server, {
      jsonrpc: '2.0',
      id: 42,
      method: 'shutdown',
    });

    expect(result).toEqual({
      response: { result: {} },
      shouldShutdown: true,
    });
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it('does not send a response for shutdown notifications', async () => {
    const { server, handleRequest } = createServer();

    const result = await dispatchStdioMcpRequest(server, {
      jsonrpc: '2.0',
      method: 'shutdown',
    });

    expect(result).toEqual({
      response: undefined,
      shouldShutdown: true,
    });
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it('ignores initialized notifications without calling the server', async () => {
    const { server, handleRequest } = createServer();

    const result = await dispatchStdioMcpRequest(server, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    expect(result).toEqual({ shouldShutdown: false });
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it('wraps successful server requests as JSON-RPC responses', async () => {
    const { server, handleRequest } = createServer(async () => ({ tools: [] }));

    const result = await dispatchStdioMcpRequest(server, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/list',
      params: { cursor: 'next' },
    });

    expect(result).toEqual({
      response: { result: { tools: [] } },
      shouldShutdown: false,
    });
    expect(handleRequest).toHaveBeenCalledWith({
      method: 'tools/list',
      params: { cursor: 'next' },
      id: 7,
    });
  });

  it('does not emit a response for successful notifications', async () => {
    const { server, handleRequest } = createServer(async () => ({ ok: true }));

    const result = await dispatchStdioMcpRequest(server, {
      jsonrpc: '2.0',
      method: 'tools/list',
    });

    expect(result).toEqual({
      response: undefined,
      shouldShutdown: false,
    });
    expect(handleRequest).toHaveBeenCalledWith({
      method: 'tools/list',
      params: undefined,
      id: undefined,
    });
  });

  it('returns JSON-RPC errors for failed requests', async () => {
    const { server } = createServer(async () => {
      throw new Error('Unknown method');
    });

    const result = await dispatchStdioMcpRequest(server, {
      jsonrpc: '2.0',
      id: 9,
      method: 'missing/method',
    });

    expect(result).toEqual({
      response: {
        error: {
          code: -32000,
          message: 'Unknown method',
        },
      },
      shouldShutdown: false,
    });
  });
});
