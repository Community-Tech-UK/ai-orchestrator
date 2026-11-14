import { describe, expect, it, vi } from 'vitest';
import { COORDINATOR_TO_NODE } from '../../remote-node/worker-node-rpc';
import { QUEUE_CALL_TIMEOUT_MS, QueueJobLinkError, RpcQueueJobLink, queueProjectKeyFor, type RpcQueueJobLinkDeps } from './queue-job-link';

const SHA = 'a'.repeat(40);

function link(node: ReturnType<RpcQueueJobLinkDeps['getNode']>, send: RpcQueueJobLinkDeps['send'] = async () => ({ have: [] })) {
  const deps = { getNode: vi.fn(() => node), send: vi.fn(send) };
  return { link: new RpcQueueJobLink(deps), deps };
}

const connected = { name: 'the Windows PC', status: 'connected', capabilities: { queueJobs: 1 } } as never;

describe('RpcQueueJobLink', () => {
  it('supports a computer only when it is connected and advertises exactly queueJobs 1', () => {
    expect(link(connected).link.supports('n')).toBe(true);
    expect(link({ ...(connected as object), status: 'disconnected' } as never).link.supports('n')).toBe(false);
    expect(link({ ...(connected as object), status: 'degraded' } as never).link.supports('n')).toBe(false);
    expect(link({ ...(connected as object), capabilities: {} } as never).link.supports('n')).toBe(false);
    expect(link({ ...(connected as object), capabilities: { queueJobs: '1' } } as never).link.supports('n')).toBe(false);
    expect(link({ ...(connected as object), capabilities: { queueJobs: 2 } } as never).link.supports('n')).toBe(false);
    expect(link(undefined).link.supports('n')).toBe(false);
  });

  it('sends each call under its method name with the per-call timeout and parses the answer', async () => {
    const { link: queue, deps } = link(connected, async () => ({ have: [SHA] }));
    expect(await queue.have('n', { project: 'p', candidates: [SHA] })).toEqual({ have: [SHA] });
    expect(deps.send).toHaveBeenCalledWith('n', COORDINATOR_TO_NODE.QUEUE_HAVE, { project: 'p', candidates: [SHA] }, QUEUE_CALL_TIMEOUT_MS.have);
  });

  it('says unsupported for a connected computer without the capability', async () => {
    const { link: queue, deps } = link({ name: 'the Windows PC', status: 'connected', capabilities: {} } as never);
    const error = await queue.have('n', { project: 'p', candidates: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QueueJobLinkError);
    expect((error as QueueJobLinkError).kind).toBe('unsupported');
    expect((error as Error).message).toMatch(/the Windows PC/);
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('says away for a computer that is not connected, or whose connection drops or times out', async () => {
    const off = await link({ name: 'the Windows PC', status: 'disconnected', capabilities: { queueJobs: 1 } } as never).link.have('n', { project: 'p', candidates: [] }).catch((e: unknown) => e);
    expect((off as QueueJobLinkError).kind).toBe('away');
    for (const message of ['RPC timeout after 30000ms: queue.have (id=coord-1)', 'Node not connected: n', 'Worker disconnected']) {
      const error = await link(connected, async () => { throw new Error(message); }).link.have('n', { project: 'p', candidates: [] }).catch((e: unknown) => e);
      expect((error as QueueJobLinkError).kind).toBe('away');
    }
  });

  it('says failed when the worker answers with an error, in plain words', async () => {
    const error = await link(connected, async () => { throw new Error('RPC error -32000: the disk is full'); }).link.have('n', { project: 'p', candidates: [] }).catch((e: unknown) => e);
    expect((error as QueueJobLinkError).kind).toBe('failed');
    expect((error as Error).message).toBe('the Windows PC could not do that: the disk is full');
  });

  it('says failed when the answer is not what the contract describes', async () => {
    const error = await link(connected, async () => ({ have: ['not a commit'] })).link.have('n', { project: 'p', candidates: [] }).catch((e: unknown) => e);
    expect((error as QueueJobLinkError).kind).toBe('failed');
  });
});

describe('queueProjectKeyFor', () => {
  it('is readable, stable and different for two folders with the same name', () => {
    expect(queueProjectKeyFor('/work/my repo')).toBe(queueProjectKeyFor('/work/my repo'));
    expect(queueProjectKeyFor('/work/my repo')).toMatch(/^my-repo-[0-9a-f]{8}$/);
    expect(queueProjectKeyFor('/a/repo')).not.toBe(queueProjectKeyFor('/b/repo'));
  });
});
