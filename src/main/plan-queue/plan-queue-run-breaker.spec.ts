import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanQueueRunBreaker } from './plan-queue-run-breaker';
import type { PlanQueueRun } from './plan-queue.types';

const MINUTE = 60_000;
let now: number;
let run: PlanQueueRun;
let breaker: PlanQueueRunBreaker;

beforeEach(() => {
  now = 1_000_000;
  run = { id: 'run', status: 'running', holdReason: null } as unknown as PlanQueueRun;
  breaker = new PlanQueueRunBreaker({
    getRun: () => run,
    setRunHold: (_id: string, holdReason: string | null) => { run = { ...run, holdReason }; },
    requestPump: vi.fn(),
  } as never, () => now);
});

const failThreeJobs = (message = 'disk unavailable') => { for (const id of ['a', 'b', 'c']) breaker.note('run', id, message); };

describe('PlanQueueRunBreaker', () => {
  it('holds the run on the third matching failure, naming the error', () => {
    breaker.note('run', 'a', 'disk unavailable');
    breaker.note('run', 'b', 'disk unavailable');
    expect(run.holdReason).toBeNull();
    breaker.note('run', 'c', 'disk unavailable');
    expect(run.holdReason).toContain('disk unavailable');
    expect(breaker.canStart(run)).toBe(false);
  });

  it('matches one fault across jobs even when each message names its own folder', () => {
    for (const id of ['a', 'b', 'c']) breaker.note('run', id, `Could not prepare /repo/.worktrees/queue/${id}: fatal`);
    expect(run.holdReason).toBeTruthy();
  });

  it('is not tripped by different faults, or by one job failing alone', () => {
    breaker.note('run', 'a', 'first problem');
    breaker.note('run', 'b', 'second problem');
    breaker.note('run', 'c', 'third problem');
    for (let attempt = 0; attempt < 5; attempt += 1) breaker.note('run', 'a', 'only this job');
    expect(run.holdReason).toBeNull();
  });

  it('counts triage, which fails for a batch and has no single job', () => {
    for (let attempt = 0; attempt < 3; attempt += 1) breaker.note('run', null, 'checker failed');
    expect(run.holdReason).toBeTruthy();
  });

  it('forgets failures older than 15 minutes', () => {
    breaker.note('run', 'a', 'disk unavailable');
    breaker.note('run', 'b', 'disk unavailable');
    now += 16 * MINUTE;
    breaker.note('run', 'c', 'disk unavailable');
    expect(run.holdReason).toBeNull();
  });

  it('allows exactly one trial after 10, 30 and 60 minutes', () => {
    failThreeJobs();
    for (const gap of [10, 30, 60]) {
      now += (gap - 1) * MINUTE;
      expect(breaker.canStart(run)).toBe(false);
      now += MINUTE;
      expect(breaker.canStart(run)).toBe(true);
      breaker.started(run, 'trial');
      expect(breaker.canStart(run)).toBe(false);
    }
  });

  it('sends a trial back in line only for the fault the run is held for', () => {
    failThreeJobs();
    now += 10 * MINUTE;
    breaker.started(run, 'trial');
    expect(breaker.isTrialOfSameFault('run', 'trial', 'disk unavailable')).toBe(true);
    expect(breaker.isTrialOfSameFault('run', 'trial', 'this document is broken')).toBe(false);
    expect(breaker.isTrialOfSameFault('run', 'other', 'disk unavailable')).toBe(false);
  });

  it('lets only the trial lift a hold, because other work can still get through during an outage', () => {
    failThreeJobs();
    breaker.succeeded('run', 'a-live-worker');
    expect(run.holdReason).toBeTruthy();
    now += 10 * MINUTE;
    breaker.started(run, 'trial');
    breaker.succeeded('run', 'someone-else');
    expect(run.holdReason).toBeTruthy();
    breaker.succeeded('run', 'trial');
    expect(run.holdReason).toBeNull();
    expect(breaker.canStart(run)).toBe(true);
  });

  it('lets a triage trial lift a hold', () => {
    for (let attempt = 0; attempt < 3; attempt += 1) breaker.note('run', null, 'checker failed');
    breaker.succeeded('run', null);
    expect(run.holdReason).toBeTruthy();
    now += 10 * MINUTE;
    breaker.started(run, null);
    breaker.succeeded('run', null);
    expect(run.holdReason).toBeNull();
  });

  it('keeps counting failures when work succeeds in between', () => {
    breaker.note('run', 'a', 'disk unavailable');
    breaker.succeeded('run', 'b');
    breaker.note('run', 'c', 'disk unavailable');
    breaker.succeeded('run', 'd');
    breaker.note('run', 'e', 'disk unavailable');
    expect(run.holdReason).toBeTruthy();
  });

  it('forgets the trial once Resume has lifted the hold, so that job fails normally', () => {
    failThreeJobs();
    now += 10 * MINUTE;
    breaker.started(run, 'trial');
    run = { ...run, holdReason: null };
    expect(breaker.isTrialOfSameFault('run', 'trial', 'disk unavailable')).toBe(false);
  });

  it('stops trying after six hours, says so on the run, and remembers after a restart', () => {
    failThreeJobs();
    now += 7 * 60 * MINUTE;
    expect(breaker.canStart(run)).toBe(false);
    expect(run.holdReason).toContain('stopped trying');
    expect(run.holdReason).toContain('disk unavailable');
    const reason = run.holdReason;
    expect(breaker.canStart(run)).toBe(false);
    expect(run.holdReason).toBe(reason);
    const restarted = new PlanQueueRunBreaker({ getRun: () => run, setRunHold: vi.fn(), requestPump: vi.fn() } as never, () => now);
    expect(restarted.canStart(run)).toBe(false);
    now += 60 * MINUTE;
    expect(restarted.canStart(run)).toBe(false);
  });

  it('keeps a hold across a restart, trying again 10 minutes later', () => {
    failThreeJobs();
    const held = run;
    const restarted = new PlanQueueRunBreaker({ getRun: () => held, setRunHold: vi.fn(), requestPump: vi.fn() } as never, () => now);
    expect(restarted.canStart(held)).toBe(false);
    now += 10 * MINUTE;
    expect(restarted.canStart(held)).toBe(true);
  });

  it('replaying the 355 October triage failures holds the run after three', () => {
    const setRunHold = vi.fn((_id: string, holdReason: string | null) => { run = { ...run, holdReason }; });
    const replay = new PlanQueueRunBreaker({ getRun: () => run, setRunHold, requestPump: vi.fn() } as never, () => now);
    for (let failure = 0; failure < 355; failure += 1) replay.note('run', null, 'Triage could not classify this document after two attempts.');
    expect(setRunHold).toHaveBeenCalledTimes(1);
  });
});
