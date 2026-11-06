import { describe, expect, it, vi } from 'vitest';
import { WorkerRpcDispatcher } from './worker-rpc-dispatcher';
import { RPC_ERROR_CODES } from '../main/remote-node/worker-node-rpc';
import { COORDINATOR_TO_NODE_PARAM_SCHEMAS } from '../main/remote-node/rpc-schemas';

describe('node.keepAwake RPC', () => {
  function setup() {
    const setKeepAwake = vi.fn(async (active: boolean) => ({ active }));
    const sendResult = vi.fn();
    const sendError = vi.fn();
    const dispatcher = new WorkerRpcDispatcher({ config: {}, instanceManager: {},
      setKeepAwake, executeNodeCommand: vi.fn(), sendResult, sendError } as never);
    return { dispatcher, setKeepAwake, sendResult, sendError };
  }
  it('validates and dispatches service-scoped enable and release', async () => {
    const { dispatcher, setKeepAwake, sendResult, sendError } = setup();
    for (const enabled of [true, false]) {
      expect(COORDINATOR_TO_NODE_PARAM_SCHEMAS['node.keepAwake'].parse({ enabled })).toEqual({ enabled });
      await dispatcher.handleRpcRequest({ jsonrpc: '2.0', id: 1, method: 'node.keepAwake',
        params: { enabled }, scope: 'service' });
      expect(setKeepAwake).toHaveBeenLastCalledWith(enabled);
      expect(sendResult).toHaveBeenLastCalledWith(1, { active: enabled });
    }
    expect(sendError).not.toHaveBeenCalled();
  });
  it('refuses unprivileged and malformed requests before a native call', async () => {
    const { dispatcher, setKeepAwake, sendError } = setup();
    await dispatcher.handleRpcRequest({ jsonrpc: '2.0', id: 1, method: 'node.keepAwake', params: { enabled: true } });
    expect(sendError).toHaveBeenLastCalledWith(1, RPC_ERROR_CODES.UNAUTHORIZED, expect.any(String));
    await dispatcher.handleRpcRequest({ jsonrpc: '2.0', id: 2, method: 'node.keepAwake',
      params: { enabled: 'true' }, scope: 'service' });
    expect(sendError).toHaveBeenLastCalledWith(2, RPC_ERROR_CODES.INVALID_PARAMS, expect.any(String));
    expect(setKeepAwake).not.toHaveBeenCalled();
  });
});
