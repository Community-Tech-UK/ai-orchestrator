import { describe, expect, it, vi } from 'vitest';
import { WorkerRpcDispatcher } from './worker-rpc-dispatcher';
import { COORDINATOR_TO_NODE, RPC_ERROR_CODES } from '../main/remote-node/worker-node-rpc';
import type { RpcMessage } from './worker-rpc-types';

function makeDispatcher(localModelSessionManager: {
  start: ReturnType<typeof vi.fn>;
  sendInput: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
}) {
  const sendResult = vi.fn();
  const sendError = vi.fn();
  const dispatcher = new WorkerRpcDispatcher({
    config: {} as never,
    instanceManager: {} as never,
    localModelSessionManager,
    getFilesystemHandler: () => ({}) as never,
    getSyncHandler: () => ({}) as never,
    getTerminalHandler: () => ({}) as never,
    applyConfigUpdate: vi.fn() as never,
    getCdpTunnel: () => ({ open: vi.fn(), send: vi.fn(), close: vi.fn() }) as never,
    stopManagedBrowser: vi.fn(async () => undefined),
    sendResult,
    sendError,
  } as never);
  return { dispatcher, sendResult, sendError };
}

function rpc(method: string, params: unknown): RpcMessage {
  return { jsonrpc: '2.0', id: 7, method, params } as RpcMessage;
}

describe('WorkerRpcDispatcher local model sessions', () => {
  it('starts local model sessions through the local session manager', async () => {
    const manager = {
      start: vi.fn(async () => ({ sessionId: 'lm-session-1' })),
      sendInput: vi.fn(),
      terminate: vi.fn(),
      interrupt: vi.fn(),
    };
    const { dispatcher, sendResult, sendError } = makeDispatcher(manager);
    const params = {
      sessionId: 'lm-session-1',
      endpointProvider: 'openai-compatible',
      endpointId: 'openai-compatible',
      modelId: 'qwen2.5-coder-14b',
      systemPrompt: 'Be concise.',
    };

    await dispatcher.handleRpcRequest(rpc(COORDINATOR_TO_NODE.LOCAL_MODEL_SESSION_START, params));

    expect(manager.start).toHaveBeenCalledWith(params);
    expect(sendResult).toHaveBeenCalledWith(7, { sessionId: 'lm-session-1' });
    expect(sendError).not.toHaveBeenCalled();
  });

  it('forwards local model session input without logging message content', async () => {
    const manager = {
      start: vi.fn(),
      sendInput: vi.fn(async () => undefined),
      terminate: vi.fn(),
      interrupt: vi.fn(),
    };
    const { dispatcher, sendResult, sendError } = makeDispatcher(manager);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const params = {
      sessionId: 'lm-session-1',
      message: 'private prompt',
      attachments: [{ name: 'private.txt', type: 'text/plain', size: 24, data: 'secret-ish fixture text' }],
    };

    try {
      await dispatcher.handleRpcRequest(rpc(COORDINATOR_TO_NODE.LOCAL_MODEL_SESSION_SEND_INPUT, params));
    } finally {
      consoleLog.mockRestore();
    }

    expect(manager.sendInput).toHaveBeenCalledWith(params);
    expect(sendResult).toHaveBeenCalledWith(7, { ok: true });
    expect(sendError).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it('validates local model session payloads before calling the manager', async () => {
    const manager = {
      start: vi.fn(),
      sendInput: vi.fn(),
      terminate: vi.fn(),
      interrupt: vi.fn(),
    };
    const { dispatcher, sendResult, sendError } = makeDispatcher(manager);

    await dispatcher.handleRpcRequest(rpc(COORDINATOR_TO_NODE.LOCAL_MODEL_SESSION_START, {
      sessionId: 'lm-session-1',
      endpointProvider: 'claude',
      endpointId: 'bad',
      modelId: 'opus',
    }));

    expect(manager.start).not.toHaveBeenCalled();
    expect(sendResult).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledWith(
      7,
      RPC_ERROR_CODES.INVALID_PARAMS,
      expect.stringContaining('endpointProvider'),
    );
  });
});
