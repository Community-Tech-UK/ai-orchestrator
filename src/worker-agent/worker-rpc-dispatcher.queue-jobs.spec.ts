import { describe, expect, it, vi } from 'vitest';
import { WorkerRpcDispatcher } from './worker-rpc-dispatcher';
import { RPC_ERROR_CODES } from '../main/remote-node/worker-node-rpc';
import type { QueueJobHostApi } from '../main/remote-node/queue-job-rpc-schemas';

const SHA = 'a'.repeat(40);
const COMMON = { project: 'proj-12345678', jobId: 'job-one', branch: 'queue/job-one-abc123' };

/** One call each: the method, params the host accepts, a malformed variant, the host method, and what it answers. */
const CASES: { method: string; host: keyof QueueJobHostApi; params: Record<string, unknown>; bad: Record<string, unknown>; answer: unknown }[] = [
  { method: 'queue.have', host: 'have', params: { project: COMMON.project, candidates: [SHA] }, bad: { project: '../x', candidates: [] }, answer: { have: [SHA] } },
  { method: 'queue.receive', host: 'receive', params: { project: COMMON.project, jobId: COMMON.jobId, uploadId: 'upload-0001', index: 0, total: 2, dataBase64: '' },
    bad: { project: COMMON.project, jobId: COMMON.jobId, uploadId: 'x', index: 0, total: 1, dataBase64: '' }, answer: { complete: false } },
  { method: 'queue.prepare', host: 'prepare', params: { ...COMMON, commit: SHA, documents: [], turnId: 'turn-1' }, bad: { ...COMMON, commit: 'short', documents: [], turnId: 'turn-1' },
    answer: { jobFolder: '/j', planningFolder: '/p', reportFolder: '/r', reportFile: '/r/turn-1.json', provisioned: [], installed: false } },
  { method: 'queue.collect', host: 'collect', params: { ...COMMON, expectedParent: SHA }, bad: { ...COMMON, expectedParent: SHA, extra: 1 },
    answer: { refused: { reason: 'session-running', message: 'busy' } } },
  { method: 'queue.fetchPack', host: 'fetchPack', params: { packId: 'pack-0000001', index: 0 }, bad: { packId: 'p', index: -1 }, answer: { dataBase64: 'AAAA' } },
  { method: 'queue.readReport', host: 'readReport', params: { jobId: COMMON.jobId, turnId: 'turn-1' }, bad: { jobId: COMMON.jobId, turnId: '../turn' }, answer: { text: null } },
  { method: 'queue.deleteLeftOut', host: 'deleteLeftOut', params: { ...COMMON, files: ['a.md'] }, bad: { ...COMMON, files: ['../a.md'] }, answer: { deleted: ['a.md'], skipped: [] } },
  { method: 'queue.remove', host: 'remove', params: COMMON, bad: { ...COMMON, branch: 'main' }, answer: { removed: true } },
  { method: 'queue.projectCheck', host: 'projectCheck', params: { project: COMMON.project, jobId: COMMON.jobId, scripts: ['lint'] }, bad: { project: COMMON.project, jobId: COMMON.jobId, scripts: ['rm -rf /'] },
    answer: { ok: true, steps: [], copyMs: 1, problem: null } },
];

function setup(withHost = true) {
  const host = Object.fromEntries(CASES.map(item => [item.host, vi.fn(async () => item.answer)])) as unknown as Record<keyof QueueJobHostApi, ReturnType<typeof vi.fn>>;
  const sendResult = vi.fn();
  const sendError = vi.fn();
  const dispatcher = new WorkerRpcDispatcher({ config: {}, instanceManager: {}, sendResult, sendError, ...(withHost ? { queueJobHost: host as unknown as QueueJobHostApi } : {}) } as never);
  return { dispatcher, host, sendResult, sendError };
}

describe.each(CASES)('$method', ({ method, host: hostMethod, params, bad, answer }) => {
  it('is answered for a service-scoped call, with params and result checked against the contract', async () => {
    const { dispatcher, host, sendResult, sendError } = setup();
    await dispatcher.handleRpcRequest({ jsonrpc: '2.0', id: 7, method, params, scope: 'service' });
    expect(host[hostMethod]).toHaveBeenCalledWith(params);
    expect(sendResult).toHaveBeenCalledWith(7, answer);
    expect(sendError).not.toHaveBeenCalled();
  });

  it('refuses an unprivileged call before the host is reached', async () => {
    const { dispatcher, host, sendResult, sendError } = setup();
    await dispatcher.handleRpcRequest({ jsonrpc: '2.0', id: 8, method, params });
    await dispatcher.handleRpcRequest({ jsonrpc: '2.0', id: 9, method, params, scope: 'instance' });
    expect(sendError).toHaveBeenNthCalledWith(1, 8, RPC_ERROR_CODES.UNAUTHORIZED, expect.any(String));
    expect(sendError).toHaveBeenNthCalledWith(2, 9, RPC_ERROR_CODES.UNAUTHORIZED, expect.any(String));
    expect(host[hostMethod]).not.toHaveBeenCalled();
    expect(sendResult).not.toHaveBeenCalled();
  });

  it('rejects malformed params before the host is reached', async () => {
    const { dispatcher, host, sendResult, sendError } = setup();
    await dispatcher.handleRpcRequest({ jsonrpc: '2.0', id: 10, method, params: bad, scope: 'service' });
    expect(sendError).toHaveBeenCalledWith(10, RPC_ERROR_CODES.INVALID_PARAMS, expect.any(String));
    expect(host[hostMethod]).not.toHaveBeenCalled();
    expect(sendResult).not.toHaveBeenCalled();
  });

  it('does not send a result the contract does not allow', async () => {
    const { dispatcher, host, sendResult, sendError } = setup();
    host[hostMethod]!.mockResolvedValueOnce({ unexpected: true });
    await dispatcher.handleRpcRequest({ jsonrpc: '2.0', id: 11, method, params, scope: 'service' });
    expect(sendResult).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledWith(11, RPC_ERROR_CODES.INVALID_PARAMS, expect.any(String));
  });

  it('answers with an error, not a silent drop, when the worker has no queue host', async () => {
    const { dispatcher, sendResult, sendError } = setup(false);
    await dispatcher.handleRpcRequest({ jsonrpc: '2.0', id: 12, method, params, scope: 'service' });
    expect(sendError).toHaveBeenCalledWith(12, RPC_ERROR_CODES.INTERNAL_ERROR, expect.stringContaining('unavailable'));
    expect(sendResult).not.toHaveBeenCalled();
  });
});

describe('queue.* errors from the host', () => {
  it('reach the coordinator as an internal error with the host\'s own words', async () => {
    const { dispatcher, host, sendError } = setup();
    host.prepare!.mockRejectedValueOnce(new Error('This computer does not hold that version of the job\'s code'));
    const item = CASES.find(entry => entry.method === 'queue.prepare')!;
    await dispatcher.handleRpcRequest({ jsonrpc: '2.0', id: 13, method: item.method, params: item.params, scope: 'service' });
    expect(sendError).toHaveBeenCalledWith(13, RPC_ERROR_CODES.INTERNAL_ERROR, expect.stringContaining('does not hold that version'));
  });
});
