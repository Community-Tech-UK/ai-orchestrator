import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkAdmission } from './work-admission';
import { limitsFor } from './workload-policy';

afterEach(() => { WorkAdmission._resetForTesting(); vi.useRealTimers(); });

describe('work admission', () => {
  it('owns an exclusive maintenance lease independently of operator pause and blocks every kind', () => {
    const admission = new WorkAdmission();
    const lease = admission.tryAcquireMaintenance();
    expect(lease).not.toBeNull();
    expect(admission.tryAcquireMaintenance()).toBeNull();
    admission.setGlobalPhase('holding');
    for (const kind of ['queue-job', 'queue-check', 'queue-checklist', 'queue-triage', 'loop-round', 'campaign-node', 'automation-run', 'repo-job', 'helper-agent', 'consult', 'background-index', 'timed-wakeup'] as const) {
      expect(admission.check(kind, { remote: true })).toMatchObject({ allowed: false, reason: 'maintenance' });
    }
    expect(() => admission.assertNotInMaintenance()).toThrow('updating');
    lease!.release();
    const next = admission.tryAcquireMaintenance();
    lease!.release();
    expect(admission.isInMaintenance()).toBe(true);
    next!.release();
    expect(admission.check('queue-job')).toMatchObject({ allowed: false, reason: 'held' });
    expect(admission.check('consult')).toEqual({ allowed: true });
  });

  it('holds engine starts while allowing a running chat to consult and spawn helpers', () => {
    const admission = new WorkAdmission({ cpuCount: () => 18, loadAverage: () => [0, 0, 0] });
    admission.setGlobalPhase('holding');
    expect(admission.check('queue-job')).toMatchObject({ allowed: false, reason: 'held' });
    expect(admission.check('automation-run')).toMatchObject({ allowed: false, reason: 'held' });
    expect(admission.check('helper-agent')).toEqual({ allowed: true });
    expect(admission.check('consult')).toEqual({ allowed: true });
    admission.setGlobalPhase('collecting');
    expect(admission.check('helper-agent')).toMatchObject({ allowed: false, reason: 'paused' });
    expect(admission.check('consult', { remote: true })).toMatchObject({ allowed: false, reason: 'paused' });
  });

  it('keeps Balanced unchanged even with a high computer load and existing work', () => {
    const admission = new WorkAdmission({ cpuCount: () => 18, loadAverage: () => [100, 100, 100] });
    admission.registerCounter('queue-job', () => 40);
    expect(admission.check('queue-job')).toEqual({ allowed: true });
    expect(admission.check('loop-round')).toEqual({ allowed: true });
    expect(Object.values(limitsFor(3, 18)).every(value => value === null)).toBe(true);
  });

  it('lets existing work finish after lowering the workload and excludes engine-owned work', () => {
    const admission = new WorkAdmission({ cpuCount: () => 18, loadAverage: () => [0, 0, 0] });
    let running = 3;
    admission.registerCounter('queue-job', () => running);
    admission.setWorkloadLevel(1);
    expect(admission.check('queue-job')).toMatchObject({ allowed: false, reason: 'over-limit' });
    expect(admission.check('queue-job', { remote: true })).toEqual({ allowed: true });
    running = 0;
    expect(admission.check('queue-job')).toEqual({ allowed: true });
  });

  it('counts work on another computer against the same limits, but ignores this Mac\'s load for it', () => {
    const admission = new WorkAdmission({ cpuCount: () => 4, loadAverage: () => [50, 50, 50] });
    admission.setWorkloadLevel(1);
    let running = 1;
    admission.registerCounter('automation-run', () => running);
    expect(admission.check('automation-run', { otherComputer: true })).toMatchObject({ allowed: false, reason: 'over-limit' });
    running = 0;
    expect(admission.check('automation-run', { otherComputer: true })).toEqual({ allowed: true });
    expect(admission.check('automation-run')).toMatchObject({ allowed: false, reason: 'computer-busy' });
  });

  it('shares the allowance between scheduled and repository jobs', () => {
    const admission = new WorkAdmission({ cpuCount: () => 18, loadAverage: () => [0, 0, 0] });
    admission.setWorkloadLevel(1);
    admission.registerCounter('repo-job', () => 1);
    expect(admission.check('automation-run')).toMatchObject({ allowed: false, reason: 'over-limit' });
  });

  it('rechecks load and dispatches deferred work exactly once after release', async () => {
    vi.useFakeTimers();
    const admission = new WorkAdmission({ cpuCount: () => 4, loadAverage: () => [0, 0, 0] });
    admission.setGlobalPhase('holding');
    let deliveries = 0;
    admission.defer('wake-1', 'timed-wakeup', () => { deliveries++; });
    admission.notifyChanged();
    expect(deliveries).toBe(0);
    admission.setGlobalPhase('none');
    await Promise.resolve();
    admission.notifyChanged();
    expect(deliveries).toBe(1);
  });

  it('runs one full checklist at a time at every workload', () => {
    const admission = new WorkAdmission({ cpuCount: () => 18, loadAverage: () => [0, 0, 0] });
    for (const level of [1, 2, 3, 4, 5] as const) {
      admission.setWorkloadLevel(level);
      expect(admission.check('queue-checklist', { activeCount: 0 })).toEqual({ allowed: true });
      expect(admission.check('queue-checklist', { activeCount: 1 })).toMatchObject({ allowed: false, reason: 'over-limit' });
    }
  });

  it('checks both load averages only on the light levels', () => {
    const admission = new WorkAdmission({ cpuCount: () => 4, loadAverage: () => [0, 4, 0] });
    admission.setWorkloadLevel(1);
    expect(admission.check('loop-round')).toMatchObject({ allowed: false, reason: 'computer-busy' });
    admission.setWorkloadLevel(5);
    expect(admission.check('loop-round')).toEqual({ allowed: true });
    expect(limitsFor(5, 18)).toMatchObject({ queueWorkerMinimum: 5, queueCheckMinimum: 4, queueLoadMinimum: 54, backgroundMultiplier: 2 });
  });

  it('replays a wake-up after the load drops without losing it', () => {
    let load = 20;
    const admission = new WorkAdmission({ cpuCount: () => 4, loadAverage: () => [load, load, 0] });
    admission.setWorkloadLevel(1);
    let fired = 0;
    admission.defer('quota-reset', 'timed-wakeup', () => { fired++; });
    expect(fired).toBe(0);
    load = 0;
    admission.notifyChanged();
    expect(fired).toBe(1);
  });

  it.each([4, 5] as const)('level %s never adds a cap or load gate to Balanced work', level => {
    const limits = limitsFor(level, 4);
    expect(limits).toMatchObject({ queueJobs: null, queueChecks: null, helperAgents: null, loopRounds: null, scheduledJobs: null, loadPerCore: null });
  });

  it('holds work that is waiting for a computer, with the reason, and starts it when one is free', () => {
    const admission = new WorkAdmission({ cpuCount: () => 4, loadAverage: () => [0, 0, 0] });
    let reason: string | null = 'Waiting for the test Mac: the test Mac is away';
    const context = { otherComputer: true, waitingForComputer: () => reason };
    expect(admission.check('automation-run', context)).toEqual({ allowed: false, reason: 'computer-busy', detail: 'Waiting for the test Mac: the test Mac is away' });
    let fired = 0;
    admission.defer('wake', 'timed-wakeup', () => { fired++; }, context);
    expect(fired).toBe(0);
    reason = null;
    admission.notifyChanged();
    expect(fired).toBe(1);
    expect(admission.check('automation-run', context)).toEqual({ allowed: true });
  });
});
