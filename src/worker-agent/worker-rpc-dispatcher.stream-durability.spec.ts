import { describe, it, expect, vi } from 'vitest';
import { WorkerRpcDispatcher } from './worker-rpc-dispatcher';
import { COORDINATOR_TO_NODE } from '../main/remote-node/worker-node-rpc';
import type { RpcMessage } from './worker-rpc-types';

function makeDispatcher() {
  const sendResult = vi.fn();
  const sendError = vi.fn();
  const replayDurableEvents = vi.fn(() => [{ instanceId: 'inst-1', replayed: 2 }]);
  const ackDurableEvents = vi.fn();
  const dispatcher = new WorkerRpcDispatcher({
    config: {} as never,
    instanceManager: {} as never,
    getFilesystemHandler: () => ({}) as never,
    getSyncHandler: () => ({}) as never,
    getTerminalHandler: () => ({}) as never,
    applyConfigUpdate: vi.fn() as never,
    getCdpTunnel: () => ({ open: vi.fn(), send: vi.fn(), close: vi.fn() }) as never,
    stopManagedBrowser: vi.fn(async () => undefined),
    sendResult,
    sendError,
    replayDurableEvents,
    ackDurableEvents,
  });
  return { dispatcher, sendResult, sendError, replayDurableEvents, ackDurableEvents };
}

describe('WorkerRpcDispatcher stream durability (WS15)', () => {
  it('node.streamResume replays after the cursors and returns the summary', async () => {
    const { dispatcher, sendResult, replayDurableEvents } = makeDispatcher();
    await dispatcher.handleRpcRequest({
      jsonrpc: '2.0',
      id: 'r-1',
      method: COORDINATOR_TO_NODE.STREAM_RESUME,
      params: { cursors: [{ instanceId: 'inst-1', afterSeq: 3 }] },
    } as RpcMessage);

    expect(replayDurableEvents).toHaveBeenCalledWith([{ instanceId: 'inst-1', afterSeq: 3 }]);
    expect(sendResult).toHaveBeenCalledWith('r-1', {
      cursors: [{ instanceId: 'inst-1', replayed: 2 }],
    });
  });

  it('node.streamResume rejects malformed cursors', async () => {
    const { dispatcher, sendError, replayDurableEvents } = makeDispatcher();
    await dispatcher.handleRpcRequest({
      jsonrpc: '2.0',
      id: 'r-2',
      method: COORDINATOR_TO_NODE.STREAM_RESUME,
      params: { cursors: [{ instanceId: '', afterSeq: -1 }] },
    } as RpcMessage);

    expect(replayDurableEvents).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalled();
  });

  it('node.streamAck notification trims via ackDurableEvents', () => {
    const { dispatcher, ackDurableEvents } = makeDispatcher();
    dispatcher.handleRpcNotification({
      jsonrpc: '2.0',
      method: COORDINATOR_TO_NODE.STREAM_ACK,
      params: { cursors: [{ instanceId: 'inst-1', seq: 7 }] },
      scope: 'service',
    } as unknown as RpcMessage);

    expect(ackDurableEvents).toHaveBeenCalledWith([{ instanceId: 'inst-1', seq: 7 }]);
  });
});
