import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type { QueueJobComputer } from '../../../shared/types/plan-queue-computers.types';
import type { WorkerNodeCapabilities } from '../../../shared/types/worker-node.types';
import { placeJob, type PlacementInput } from './plan-queue-remote-placement';

const KEY = 'repo-12345678';
const computer = (change: Partial<QueueJobComputer> = {}): QueueJobComputer => ({
  nodeId: 'pc', label: 'the Windows PC', takesJobs: true, paused: false, jobsAtOnce: 2,
  projects: { [KEY]: { ok: true, checkedAt: 1, problem: null, summary: 'fine' } }, ...change,
});
const caps = (change: Partial<WorkerNodeCapabilities> = {}): WorkerNodeCapabilities => ({
  queueJobs: 1, signIns: [{ provider: 'claude', profileId: 'legacy', state: 'signed-in' }], ...change,
} as WorkerNodeCapabilities);

function input(change: { computers?: QueueJobComputer[]; connected?: Record<string, boolean>; capabilities?: Record<string, WorkerNodeCapabilities>;
  kind?: 'plans' | 'livetests'; provider?: string | null; keep?: boolean; jobs?: Record<string, number>; useThisMac?: boolean } = {}): PlacementInput {
  const computers = change.computers ?? [computer()];
  return {
    run: { kind: change.kind ?? 'plans', workerProvider: change.provider ?? null, config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, keepOnThisMac: change.keep } },
    item: { id: 'item' }, computers,
    nodes: {
      isConnected: id => change.connected?.[id] ?? true,
      capabilities: id => change.capabilities?.[id] ?? caps(),
    },
    jobsOn: id => change.jobs?.[id] ?? 0,
    projectKey: KEY,
    ...(change.useThisMac === undefined ? {} : { useThisMac: change.useThisMac }),
  };
}

describe('where a Plan Queue job runs', () => {
  it('goes to the first computer that takes jobs and passes every test', () => {
    expect(placeJob(input())).toEqual({ kind: 'there', computer: { nodeId: 'pc', label: 'the Windows PC' } });
  });

  it('takes the computers in order and skips one that is refused', () => {
    const second = computer({ nodeId: 'mac2', label: 'the test Mac' });
    expect(placeJob(input({ computers: [computer({ paused: true }), second], capabilities: { mac2: caps() } })))
      .toEqual({ kind: 'there', computer: { nodeId: 'mac2', label: 'the test Mac' } });
  });

  it('stays here, with no note, for a live-test job, a run kept on this Mac, and when no computer takes jobs', () => {
    expect(placeJob(input({ kind: 'livetests' }))).toEqual({ kind: 'here', reason: null });
    expect(placeJob(input({ keep: true }))).toEqual({ kind: 'here', reason: null });
    expect(placeJob(input({ computers: [computer({ takesJobs: false })] }))).toEqual({ kind: 'here', reason: null });
    expect(placeJob(input({ computers: [] }))).toEqual({ kind: 'here', reason: null });
  });

  it.each([
    ['is paused', input({ computers: [computer({ paused: true })] }), 'the Windows PC is paused'],
    ['is away', input({ connected: { pc: false } }), 'the Windows PC is away'],
    ['has an older Harness', input({ capabilities: { pc: caps({ queueJobs: undefined }) } }), 'needs the newer Harness'],
    ['has reported no sign-ins', input({ capabilities: { pc: caps({ signIns: undefined }) } }), "hasn't reported its sign-ins"],
    ['is not signed in to the job\'s tool', input({ provider: 'codex' }), "isn't signed in to Codex"],
    ['is signed out of everything', input({ capabilities: { pc: caps({ signIns: [{ provider: 'claude', profileId: 'legacy', state: 'signed-out' }] }) } }), "isn't signed in to Claude or Codex"],
    ['runs a tool it has no sign-in report for', input({ provider: 'gemini' }), 'only runs Claude and Codex jobs'],
    ['is full', input({ jobs: { pc: 2 } }), 'already has 2 jobs (its limit)'],
    ['has not been checked for the project', input({ computers: [computer({ projects: {} })] }), "hasn't been checked for this project"],
    ['failed the check for the project', input({ computers: [computer({ projects: { [KEY]: { ok: false, checkedAt: 1, problem: 'lint does not run', summary: '' } } })] }), 'failed the check for this project (lint does not run)'],
  ])('stays here, saying why, when the computer %s', (_name, given, words) => {
    const placed = placeJob(given);
    expect(placed.kind).toBe('here');
    expect((placed as { reason: string }).reason).toContain(words);
  });

  it('names every computer that refused', () => {
    const placed = placeJob(input({ computers: [computer({ paused: true }), computer({ nodeId: 'mac2', label: 'the test Mac', jobsAtOnce: 1 })], jobs: { mac2: 1 }, capabilities: { mac2: caps() } }));
    expect((placed as { reason: string }).reason).toContain('the Windows PC is paused');
    expect((placed as { reason: string }).reason).toContain('the test Mac already has 1 job (its limit)');
  });

  it('accepts a signed-in Codex for a Codex job and any sign-in for an automatic choice', () => {
    expect(placeJob(input({ provider: 'codex', capabilities: { pc: caps({ signIns: [{ provider: 'codex', profileId: 'legacy', state: 'signed-in' }] }) } })).kind).toBe('there');
    expect(placeJob(input({ provider: 'auto' })).kind).toBe('there');
  });
});

describe('with this Mac switched off for jobs', () => {
  const off = { useThisMac: false };

  it.each([
    ['is away', { connected: { pc: false } }, 'the Windows PC is away'],
    ['is paused', { computers: [computer({ paused: true })] }, 'the Windows PC is paused'],
    ['is at its limit', { jobs: { pc: 2 } }, 'already has 2 jobs'],
  ])('waits when the only computer %s', (_name, change, text) => {
    const placement = placeJob(input({ ...off, ...change }));
    expect(placement.kind).toBe('wait');
    expect(placement).toMatchObject({ reason: expect.stringContaining(text) });
  });

  it('still goes to a computer that can take the job', () => {
    expect(placeJob(input(off))).toEqual({ kind: 'there', computer: { nodeId: 'pc', label: 'the Windows PC' } });
  });

  it('waits if any computer is only busy, even when another can never take the job', () => {
    const placement = placeJob(input({ ...off, computers: [computer({ nodeId: 'mac', label: 'the test Mac' }), computer()], jobs: { pc: 2 },
      capabilities: { mac: caps({ signIns: [] }) } }));
    expect(placement.kind).toBe('wait');
  });

  it.each([
    ['a tool that is not signed in', { provider: 'codex' }],
    ['a project that was never checked', { computers: [computer({ projects: {} })] }],
    ['a tool other computers cannot run', { provider: 'gemini' }],
    ['an older Harness', { capabilities: { pc: caps({ queueJobs: 0 as never }) } }],
  ])('runs here, with the reason, for %s', (_name, change) => {
    const placement = placeJob(input({ ...off, ...change }));
    expect(placement.kind).toBe('here');
    expect(placement).toMatchObject({ reason: expect.stringContaining('This job runs on this Mac because') });
  });

  it.each([
    ['paused and not signed in to the job\'s tool', { provider: 'codex', computers: [computer({ paused: true })] }, "isn't signed in to Codex"],
    ['paused and signed out of everything', { computers: [computer({ paused: true })],
      capabilities: { pc: caps({ signIns: [{ provider: 'claude', profileId: 'legacy', state: 'signed-out' }] }) } }, "isn't signed in to Claude or Codex"],
    ['away, with its last report showing no sign-in for the job\'s tool', { provider: 'codex', connected: { pc: false } }, "isn't signed in to Codex"],
    ['away and asked for a tool other computers cannot run', { provider: 'gemini', connected: { pc: false } }, 'only runs Claude and Codex jobs'],
    ['paused and never checked for the project', { computers: [computer({ paused: true, projects: {} })] }, "hasn't been checked for this project"],
  ])('runs here, not waiting, when the only computer is %s', (_name, change, text) => {
    const placement = placeJob(input({ ...off, ...change }));
    expect(placement.kind).toBe('here');
    expect(placement).toMatchObject({ reason: expect.stringContaining(text) });
    expect(placement).toMatchObject({ reason: expect.not.stringContaining('is paused') });
  });

  it('waits for an away computer whose report is gone, since its sign-ins are not known', () => {
    const placement = placeJob({ ...input({ ...off, provider: 'codex' }), nodes: { isConnected: () => false, capabilities: () => undefined } });
    expect(placement).toEqual({ kind: 'wait', reason: 'Waiting for a computer: the Windows PC is away. This Mac is switched off for jobs.' });
  });

  it('says why when no computer is set to take jobs, and stays quiet with the switch on', () => {
    expect(placeJob(input({ ...off, computers: [computer({ takesJobs: false })] }))).toEqual({
      kind: 'here', reason: 'This job runs on this Mac because no other computer is set to take Plan Queue jobs.' });
    expect(placeJob(input({ computers: [computer({ takesJobs: false })] }))).toEqual({ kind: 'here', reason: null });
  });

  it('keeps live-test jobs and runs kept on this Mac here, with no note', () => {
    expect(placeJob(input({ ...off, kind: 'livetests', connected: { pc: false } }))).toEqual({ kind: 'here', reason: null });
    expect(placeJob(input({ ...off, keep: true, connected: { pc: false } }))).toEqual({ kind: 'here', reason: null });
  });

  it('still runs a job here when the switch is on and the computer is away', () => {
    expect(placeJob(input({ useThisMac: true, connected: { pc: false } })).kind).toBe('here');
  });
});
