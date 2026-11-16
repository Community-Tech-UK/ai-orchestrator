import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('./worker-node-registry', () => ({ getWorkerNodeRegistry: () => ({ getNode: () => undefined }) }));
import { WorkerNodeConnectionServer } from './worker-node-connection';
import { COORDINATOR_TO_NODE } from './worker-node-rpc';
afterEach(() => WorkAdmission._resetForTesting());
describe('remote work at the source update handoff', () => {
  it.each([COORDINATOR_TO_NODE.NODE_EXEC, COORDINATOR_TO_NODE.QUEUE_PREPARE,
    COORDINATOR_TO_NODE.INSTANCE_CHANGE_MODEL, COORDINATOR_TO_NODE.BROWSER_CDP_SEND])('blocks new %s and sees a request already in flight', async method => {
    const receiver = { pending: new Map([[1, { isWork: true, method }]]) };
    expect(WorkerNodeConnectionServer.prototype.hasActiveWork.call(receiver as never)).toBe(true);
    const lease = getWorkAdmission().tryAcquireMaintenance();
    try {
      await expect(WorkerNodeConnectionServer.prototype.sendRpc.call({} as never, 'worker', method)).rejects.toThrow('updating');
    } finally { lease?.release(); }
  });
  it.each([COORDINATOR_TO_NODE.INSTANCE_TERMINATE, COORDINATOR_TO_NODE.INSTANCE_INTERRUPT,
    COORDINATOR_TO_NODE.INSTANCE_HIBERNATE, COORDINATOR_TO_NODE.LOCAL_MODEL_SESSION_TERMINATE])('allows normal quit cleanup through %s while the lease is held', async method => {
    const lease = getWorkAdmission().tryAcquireMaintenance();
    const receiver = { requestCounter: 0, pending: new Map(), nodeToSocket: new Map() };
    try {
      await expect(WorkerNodeConnectionServer.prototype.sendRpc.call(receiver as never, 'worker', method)).rejects.toThrow('Node not connected');
    } finally { lease?.release(); }
  });
});
