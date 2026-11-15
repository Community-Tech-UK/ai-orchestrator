import { describe, expect, it, vi } from 'vitest';
import { WorkerAgent } from './worker-agent';

describe('WorkerAgent private device-login routing', () => {
  it('passes the actual incoming socket to private dispatch before ordinary RPC or response handling', () => {
    const source = {};
    const privateDispatch = vi.fn(() => true);
    const ordinary = vi.fn();
    const receiver = { codexDeviceLogin: { handleMessage: privateDispatch }, handleRpcRequest: ordinary, resolvePendingRequest: ordinary };
    const dispatch = Reflect.get(WorkerAgent.prototype, 'handleMessage');
    const request = { jsonrpc: '2.0', id: 'request', method: 'provider.codexDevice.start', params: {} };
    dispatch.call(receiver, JSON.stringify(request), source);
    const ack = { jsonrpc: '2.0', id: 'codex-device-private-test', result: { delivered: true } };
    dispatch.call(receiver, JSON.stringify(ack), source);
    expect(privateDispatch.mock.calls).toEqual([[request, source], [ack, source]]);
    expect(ordinary).not.toHaveBeenCalled();
  });

  it('closes private operations on connection reset before rejecting ordinary requests', () => {
    const order: string[] = [];
    const receiver = {
      codexDeviceLogin: { shutdown: () => order.push('private') },
      stopHeartbeat: vi.fn(), keepAwake: { shutdown: vi.fn() },
      rejectPendingRequests: () => order.push('ordinary'), cdpTunnel: { closeAll: vi.fn() }, registrationAccepted: true,
    };
    Reflect.get(WorkerAgent.prototype, 'resetCoordinatorSession').call(receiver, 'test-disconnect');
    expect(order).toEqual(['private', 'ordinary']);
    expect(receiver.registrationAccepted).toBe(false);
  });

  it('does not copy malformed incoming payloads into diagnostic logs', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      Reflect.get(WorkerAgent.prototype, 'handleMessage').call({}, 'PRIVATE_PLACEHOLDER{');
      expect(error).toHaveBeenCalledWith('Invalid JSON from coordinator');
      expect(JSON.stringify(error.mock.calls)).not.toContain('PRIVATE_PLACEHOLDER');
    } finally { error.mockRestore(); }
  });
});
