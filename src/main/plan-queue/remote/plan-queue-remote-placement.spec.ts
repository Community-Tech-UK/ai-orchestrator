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
  kind?: 'plans' | 'livetests'; provider?: string | null; keep?: boolean; jobs?: Record<string, number> } = {}): PlacementInput {
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
