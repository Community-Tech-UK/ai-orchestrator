import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  handleOneShotOrchestratorToolsRpcSocket,
  type OrchestratorToolsRpcSocketRequest,
} from './orchestrator-tools-rpc-socket';

/**
 * Minimal fake satisfying the net.Socket surface
 * `handleOneShotOrchestratorToolsRpcSocket` actually uses: on/off/once('data'
 * | 'error' | 'close') and end(). Real `net.Socket` integration is exercised
 * separately by `orchestrator-tools-rpc-server.spec.ts`'s socket-roundtrip
 * tests; this file isolates the framing/auth/abort logic itself.
 */
class FakeSocket extends EventEmitter {
  written: string[] = [];
  ended = false;

  override off(event: string, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }

  end(payload?: string): this {
    this.ended = true;
    if (payload) this.written.push(payload);
    return this;
  }

  sendLine(request: unknown): void {
    this.emit('data', Buffer.from(`${JSON.stringify(request)}\n`, 'utf-8'));
  }
}

function lastResponse(socket: FakeSocket): { id: unknown; result?: unknown; error?: { message: string } } {
  expect(socket.written).toHaveLength(1);
  return JSON.parse(socket.written[0]!) as { id: unknown; result?: unknown; error?: { message: string } };
}

describe('handleOneShotOrchestratorToolsRpcSocket', () => {
  it('authenticates, then handles the request and writes back the result', async () => {
    const socket = new FakeSocket();
    const handle = vi.fn(async () => ({ ok: true }));
    handleOneShotOrchestratorToolsRpcSocket(socket as never, {
      maxMessageBytes: 1024,
      authenticate: () => undefined,
      handle,
    });

    socket.sendLine({ jsonrpc: '2.0', id: 1, method: 'orchestrator_tools.git_batch_pull', params: {} });
    await vi.waitFor(() => expect(socket.ended).toBe(true));

    expect(handle).toHaveBeenCalledOnce();
    expect(lastResponse(socket)).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  });

  it('rejects the request when authenticate throws, without calling handle', async () => {
    const socket = new FakeSocket();
    const handle = vi.fn(async () => ({ ok: true }));
    handleOneShotOrchestratorToolsRpcSocket(socket as never, {
      maxMessageBytes: 1024,
      authenticate: () => {
        throw new Error('invalid or missing orchestrator-tools capability token');
      },
      handle,
    });

    socket.sendLine({ jsonrpc: '2.0', id: 2, method: 'orchestrator_tools.git_batch_pull', params: {} });
    await vi.waitFor(() => expect(socket.ended).toBe(true));

    expect(handle).not.toHaveBeenCalled();
    const response = lastResponse(socket);
    expect(response.error?.message).toBe('invalid or missing orchestrator-tools capability token');
  });

  it('rejects malformed JSON with a parse-error envelope', async () => {
    const socket = new FakeSocket();
    handleOneShotOrchestratorToolsRpcSocket(socket as never, {
      maxMessageBytes: 1024,
      authenticate: () => undefined,
      handle: async () => ({}),
    });

    socket.emit('data', Buffer.from('not json\n', 'utf-8'));
    await vi.waitFor(() => expect(socket.ended).toBe(true));

    expect(lastResponse(socket).error?.message).toBe('Invalid orchestrator-tools RPC request JSON');
  });

  it('rejects an oversized message before ever parsing it', async () => {
    const socket = new FakeSocket();
    const handle = vi.fn(async () => ({}));
    handleOneShotOrchestratorToolsRpcSocket(socket as never, {
      maxMessageBytes: 8,
      authenticate: () => undefined,
      handle,
    });

    socket.emit('data', Buffer.from('x'.repeat(64), 'utf-8'));
    await vi.waitFor(() => expect(socket.ended).toBe(true));

    expect(handle).not.toHaveBeenCalled();
    expect(lastResponse(socket).error?.message).toBe('Orchestrator-tools RPC request too large');
  });

  it('ignores a second request on the same one-shot connection', async () => {
    const socket = new FakeSocket();
    const handle = vi.fn(async () => ({ ok: true }));
    handleOneShotOrchestratorToolsRpcSocket(socket as never, {
      maxMessageBytes: 1024,
      authenticate: () => undefined,
      handle,
    });

    socket.sendLine({ jsonrpc: '2.0', id: 1, method: 'orchestrator_tools.git_batch_pull', params: {} });
    socket.sendLine({ jsonrpc: '2.0', id: 2, method: 'orchestrator_tools.git_batch_pull', params: {} });
    await vi.waitFor(() => expect(socket.ended).toBe(true));

    expect(handle).toHaveBeenCalledOnce();
  });

  it('aborts the in-flight handler signal when the socket closes before it resolves (release main-process state on disconnect)', async () => {
    const socket = new FakeSocket();
    let capturedSignal: AbortSignal | undefined;
    let releaseHandler: (() => void) | undefined;
    const handle = vi.fn((_request: OrchestratorToolsRpcSocketRequest, abortSignal: AbortSignal) => {
      capturedSignal = abortSignal;
      return new Promise((resolve) => {
        releaseHandler = () => resolve({ tooLate: true });
      });
    });
    handleOneShotOrchestratorToolsRpcSocket(socket as never, {
      maxMessageBytes: 1024,
      authenticate: () => undefined,
      handle,
    });

    socket.sendLine({ jsonrpc: '2.0', id: 1, method: 'orchestrator_tools.read_node_output', params: {} });
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    expect(capturedSignal?.aborted).toBe(false);

    // The client (aio-mcp forwarder) disconnected before the long-poll finished.
    socket.emit('close');

    expect(capturedSignal?.aborted).toBe(true);
    releaseHandler?.();
  });

  it('does not abort the handler signal when the request completes normally', async () => {
    const socket = new FakeSocket();
    let capturedSignal: AbortSignal | undefined;
    const handle = vi.fn((_request: OrchestratorToolsRpcSocketRequest, abortSignal: AbortSignal) => {
      capturedSignal = abortSignal;
      return Promise.resolve({ ok: true });
    });
    handleOneShotOrchestratorToolsRpcSocket(socket as never, {
      maxMessageBytes: 1024,
      authenticate: () => undefined,
      handle,
    });

    socket.sendLine({ jsonrpc: '2.0', id: 1, method: 'orchestrator_tools.git_batch_pull', params: {} });
    await vi.waitFor(() => expect(socket.ended).toBe(true));

    expect(capturedSignal?.aborted).toBe(false);
  });
});
