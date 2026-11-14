import { describe, expect, it, vi } from 'vitest';
import { newPlanQueueItem } from '../plan-queue-state';
import type { PlanQueueItem } from '../plan-queue.types';
import { QueueJobLinkError } from './queue-job-link';
import { PlanQueueRemoteFlow } from './plan-queue-remote-flow';
import { RemoteCollectRefused } from './plan-queue-remote-turns';

const REMOTE = { nodeId: 'pc', label: 'the Windows PC', branch: 'queue/x', lastExchangedCommit: 'a'.repeat(40), turnStartCommit: 'a'.repeat(40), turnId: 't1' };
const run = { id: 'run', workspaceCwd: '/repo' };

function setup(change: { away?: boolean; expired?: boolean; saveRound?: () => Promise<unknown>; collect?: () => Promise<unknown>; heldAt?: number | null; awaySince?: number | null } = {}) {
  let item: PlanQueueItem = { ...newPlanQueueItem('job', 'run', '/repo/docs/plans/p_plan.md', 1, { state: 'working', worktreePath: '/wt', branchName: 'queue/x', workerInstanceId: 'w' }),
    remote: { ...REMOTE, ...(change.awaySince !== undefined ? { awaySince: change.awaySince } : {}) }, ...(change.heldAt !== undefined ? { heldAt: change.heldAt } : {}) };
  const turns = {
    saveRound: vi.fn(change.saveRound ?? (async (it: PlanQueueItem) => ({ item: it, hold: null }))),
    collect: vi.fn(change.collect ?? (async () => ({ leftOut: [], hold: null, summary: 'Copied 2 changed files back from the Windows PC.' }))),
    fallBackHere: vi.fn(async (it: PlanQueueItem) => { item = { ...it, remote: null, detail: 'Carrying on here' }; return item; }),
    markAway: vi.fn((it: PlanQueueItem) => it), isAway: vi.fn(() => change.away === true), awayExpired: vi.fn(() => change.expired === true),
    release: vi.fn(async (it: PlanQueueItem) => ({ ...it, remote: null })),
    arrange: vi.fn(async (it: PlanQueueItem) => it),
  };
  const host = {
    getItem: () => item, getRun: () => run, save: vi.fn((it: PlanQueueItem) => { item = it; return it; }), requestPump: vi.fn(),
    worktrees: { checkpoint: vi.fn(async (it: PlanQueueItem) => ({ ...it, checkpointCommit: 'c'.repeat(40) })) },
  };
  const hold = vi.fn(async () => undefined); const park = vi.fn(async () => undefined);
  const flow = new PlanQueueRemoteFlow({ host: host as never, turns: turns as never, lock: (_id, action) => action(), hold, park, terminateRemoteSession: vi.fn(async () => undefined) });
  return { flow, turns, host, hold, park, item: () => item };
}

describe('saving a remote turn', () => {
  it('returns the saved item and any hold text', async () => {
    const s = setup({ saveRound: async () => ({ item: newPlanQueueItem('job', 'run', 'x', 1), hold: 'the plan changed here while the job was on the Windows PC' }) });
    expect(await s.flow.saveTurn(s.item(), run as never, 'round 1 work')).toMatchObject({ kind: 'done', hold: 'the plan changed here while the job was on the Windows PC' });
  });

  it('holds the job, saying the computer went away, when it is unreachable', async () => {
    const s = setup({ saveRound: async () => { throw new QueueJobLinkError('away', 'the Windows PC is away'); } });
    expect(await s.flow.saveTurn(s.item(), run as never, 'round 1 work')).toEqual({ kind: 'held' });
    expect(s.turns.markAway).toHaveBeenCalled();
    expect(s.hold).toHaveBeenCalledWith(expect.anything(), 'the Windows PC went away; waiting for it');
  });

  it('parks the job with the computer\'s reason when it refuses, and does not carry on here', async () => {
    const s = setup({ saveRound: async () => { throw new RemoteCollectRefused('The agent made a commit. Its work is kept on the Windows PC.', 'agent-committed'); } });
    expect(await s.flow.saveTurn(s.item(), run as never, 'round 1 work')).toEqual({ kind: 'parked' });
    expect(s.park).toHaveBeenCalledWith(expect.anything(), 'The agent made a commit. Its work is kept on the Windows PC.');
    expect(s.turns.fallBackHere).not.toHaveBeenCalled();
  });

  it.each(['no-copy', 'not-prepared'])('carries on here from the last checkpoint when the computer has no copy (%s)', async reason => {
    const s = setup({ saveRound: async () => { throw new RemoteCollectRefused('gone', reason); } });
    const outcome = await s.flow.saveTurn(s.item(), run as never, 'round 1 work');
    expect(outcome).toMatchObject({ kind: 'done', hold: null });
    expect(s.turns.fallBackHere).toHaveBeenCalled();
    expect(s.host.worktrees.checkpoint).toHaveBeenCalled();
  });

  it('carries on here when the computer can no longer take jobs (an older Harness after it reconnected)', async () => {
    const s = setup({ saveRound: async () => { throw new QueueJobLinkError('unsupported', 'needs the newer Harness'); } });
    expect(await s.flow.saveTurn(s.item(), run as never, 'round 1 work')).toMatchObject({ kind: 'done' });
    expect(s.turns.fallBackHere).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('cannot take Plan Queue jobs'));
  });

  it('parks the job and keeps the work there when the computer answers with a fault, instead of throwing the work away', async () => {
    const s = setup({ saveRound: async () => { throw new QueueJobLinkError('failed', 'a path is too long'); } });
    expect(await s.flow.saveTurn(s.item(), run as never, 'round 1 work')).toEqual({ kind: 'parked' });
    expect(s.park).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Its work is kept on the Windows PC'));
    expect(s.turns.fallBackHere).not.toHaveBeenCalled();
  });

  it('lets an unexpected error through to the flow\'s own handling', async () => {
    const s = setup({ saveRound: async () => { throw new Error('disk full'); } });
    await expect(s.flow.saveTurn(s.item(), run as never, 'round 1 work')).rejects.toThrow('disk full');
  });
});

describe('a job whose computer went away', () => {
  it('keeps waiting while it is away and not yet ten minutes', async () => {
    const s = setup({ away: true, heldAt: 1, awaySince: 1 });
    expect(await s.flow.awayTick('job')).toBe('again');
    expect(s.turns.fallBackHere).not.toHaveBeenCalled();
  });

  it('carries on here from the last checkpoint after ten minutes away, and wakes the queue', async () => {
    const s = setup({ away: true, expired: true, heldAt: 1, awaySince: 1 });
    expect(await s.flow.awayTick('job')).toBe('done');
    expect(s.turns.fallBackHere).toHaveBeenCalledWith(expect.anything(), 'the Windows PC was away for ten minutes');
    expect(s.item().heldAt).toBeNull();
    expect(s.host.requestPump).toHaveBeenCalled();
  });

  it('collects the work when the computer is back before the ten minutes, then lets the job carry on there', async () => {
    const s = setup({ away: false, heldAt: 1, awaySince: 1 });
    expect(await s.flow.awayTick('job')).toBe('done');
    expect(s.turns.saveRound).toHaveBeenCalledWith(expect.anything(), run, 'recovered work from the Windows PC', expect.any(Function), { copyBack: true });
    expect(s.item().heldAt).toBeNull();
    expect(s.item().remote!.awaySince).toBeNull();
    expect(s.turns.fallBackHere).not.toHaveBeenCalled();
  });

  it('stops the old session there before collecting, and stays held when the plan changed here meanwhile', async () => {
    const terminate = vi.fn(async () => undefined);
    const s = setup({ away: false, heldAt: 7, awaySince: 1, saveRound: async () => ({ item: newPlanQueueItem('job', 'run', 'x', 1, { remote: { ...REMOTE, instanceId: 'worker-1' } } as never), hold: 'the plan changed here while the job was on the Windows PC' }) });
    const flow = new PlanQueueRemoteFlow({ host: s.host as never, turns: s.turns as never, lock: (_i, a) => a(), hold: s.hold, park: s.park, terminateRemoteSession: terminate });
    s.item().remote!.instanceId = 'worker-1';
    await flow.awayTick('job');
    expect(terminate).toHaveBeenCalledWith('pc', 'worker-1');
    expect(s.item().heldAt).toBe(7);
    expect(s.item().detail).toBe('the plan changed here while the job was on the Windows PC');
    expect(s.host.requestPump).not.toHaveBeenCalled();
  });

  it('carries on here when the computer comes back with no copy of the job', async () => {
    const s = setup({ away: false, heldAt: 1, awaySince: 1, saveRound: async () => { throw new RemoteCollectRefused('gone', 'no-copy'); } });
    await s.flow.awayTick('job');
    expect(s.turns.fallBackHere).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('no longer has this job'));
  });

  it('does nothing for a job that is no longer held for it', async () => {
    const s = setup({ away: true, heldAt: null, awaySince: 1 });
    expect(await s.flow.awayTick('job')).toBe('done');
    expect(s.turns.fallBackHere).not.toHaveBeenCalled();
  });
});

describe('starting a turn for a job whose last turn was kept on its computer', () => {
  it('collects and saves the kept work before the job is sent out again, so sending cannot overwrite it', async () => {
    const order: string[] = [];
    const s = setup({ saveRound: async () => { order.push('saveRound'); return { item: newPlanQueueItem('job', 'run', 'x', 1, { remote: { ...REMOTE, turnId: null }, worktreePath: '/wt' } as never), hold: null }; } });
    s.turns.arrange.mockImplementation(async (it: PlanQueueItem) => { order.push('arrange'); return it; });
    const arranged = await s.flow.arrange(s.item(), run as never);
    expect(order).toEqual(['saveRound', 'arrange']);
    expect(s.turns.saveRound).toHaveBeenCalledWith(expect.anything(), run, 'recovered work from the Windows PC', expect.any(Function));
    expect(arranged?.remote?.turnId).toBeNull();
  });

  it('sends the job out without collecting when nothing was kept there', async () => {
    const s = setup();
    s.item().remote!.turnId = null;
    await s.flow.arrange(s.item(), run as never);
    expect(s.turns.saveRound).not.toHaveBeenCalled();
    expect(s.turns.arrange).toHaveBeenCalled();
  });

  it('stops, without sending, when the computer is away again: the job is held and the work stays there', async () => {
    const s = setup({ saveRound: async () => { throw new QueueJobLinkError('away', 'the Windows PC is away'); } });
    expect(await s.flow.arrange(s.item(), run as never)).toBeNull();
    expect(s.hold).toHaveBeenCalled();
    expect(s.turns.arrange).not.toHaveBeenCalled();
  });

  it('stops, without sending, when the computer refuses to hand the work over: the job is parked and the work stays there', async () => {
    const s = setup({ saveRound: async () => { throw new RemoteCollectRefused('refused. Its work is kept on the Windows PC.', 'agent-committed'); } });
    expect(await s.flow.arrange(s.item(), run as never)).toBeNull();
    expect(s.park).toHaveBeenCalled();
    expect(s.turns.arrange).not.toHaveBeenCalled();
  });

  it('holds the job for James, without sending, when the plan changed here while the work was on the computer', async () => {
    const s = setup({ saveRound: async () => ({ item: newPlanQueueItem('job', 'run', 'x', 1, { remote: { ...REMOTE, turnId: null } } as never), hold: 'the plan changed here' }) });
    expect(await s.flow.arrange(s.item(), run as never)).toBeNull();
    expect(s.hold).toHaveBeenCalledWith(expect.anything(), 'the plan changed here');
    expect(s.turns.arrange).not.toHaveBeenCalled();
  });
});

describe('stopping a remote job (pause, park)', () => {
  it('skips the copy-back for an away computer and says later work there is not included', async () => {
    const s = setup({ away: true });
    const back = await s.flow.copyBackForStop(s.item(), run as never);
    expect(back.notes[0]).toContain("isn't included yet");
    expect(back.keepThere).toBe(true);
    expect(s.turns.collect).not.toHaveBeenCalled();
  });

  it('collects nothing from a job between turns, so a pause or park after a merge here is not refused for the moved folder', async () => {
    const s = setup();
    s.item().remote!.turnId = null;
    expect(await s.flow.copyBackForStop(s.item(), run as never)).toMatchObject({ notes: [], keepThere: false });
    expect(s.turns.collect).not.toHaveBeenCalled();
  });

  it('keeps the far copy when the computer answers with a fault', async () => {
    const s = setup({ collect: async () => { throw new QueueJobLinkError('failed', 'disk full'); } });
    const back = await s.flow.copyBackForStop(s.item(), run as never);
    expect(back.keepThere).toBe(true);
    expect(back.notes[0]).toContain('is kept there');
  });

  it('marks the copy collected, so a later stop does not collect the same turn again', async () => {
    const s = setup();
    const back = await s.flow.copyBackForStop(s.item(), run as never);
    expect(back.item.remote!.turnId).toBeNull();
  });

  it('keeps the far copy for James to look at when the computer refuses', async () => {
    const s = setup({ collect: async () => { throw new RemoteCollectRefused('a commit was made. Its work is kept on the Windows PC.', 'agent-committed'); } });
    const back = await s.flow.copyBackForStop(s.item(), run as never);
    expect(back.keepThere).toBe(true);
    expect(back.notes[0]).toContain('kept on the Windows PC');
  });

  it('does not keep a copy that no longer exists there', async () => {
    const s = setup({ collect: async () => { throw new RemoteCollectRefused('gone', 'no-copy'); } });
    expect((await s.flow.copyBackForStop(s.item(), run as never)).keepThere).toBe(false);
  });

  it('copies the work back when it can, and leaves a job that runs here alone', async () => {
    const s = setup();
    expect((await s.flow.copyBackForStop(s.item(), run as never)).notes[0]).toContain('Copied 2 changed files');
    const here = { ...s.item(), remote: null };
    expect(await s.flow.copyBackForStop(here, run as never)).toEqual({ item: here, notes: [], keepThere: false });
  });

  it('on restart stops the old session there, then saves its work; an away computer holds the job', async () => {
    const s = setup();
    const terminate = vi.fn(async () => undefined);
    const flow = new PlanQueueRemoteFlow({ host: s.host as never, turns: s.turns as never, lock: (_i, a) => a(), hold: s.hold, park: s.park, terminateRemoteSession: terminate });
    expect(await flow.recoverAfterRestart(s.item(), run as never)).toBeTruthy();
    expect(terminate).toHaveBeenCalledWith('pc', 'w');
    const away = setup({ away: true });
    expect(await away.flow.recoverAfterRestart(away.item(), run as never)).toBeNull();
    expect(away.hold).toHaveBeenCalled();
  });
});
