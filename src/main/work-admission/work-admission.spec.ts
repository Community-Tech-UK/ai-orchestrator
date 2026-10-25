import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkAdmission } from './work-admission';
import { limitsFor } from './workload-policy';

afterEach(() => { WorkAdmission._resetForTesting(); vi.useRealTimers(); });

describe('work admission', () => {
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

  it('lets existing work finish after lowering the workload and excludes remote work', () => {
    const admission = new WorkAdmission({ cpuCount: () => 18, loadAverage: () => [0, 0, 0] });
    let running = 3;
    admission.registerCounter('queue-job', () => running);
    admission.setWorkloadLevel(1);
    expect(admission.check('queue-job')).toMatchObject({ allowed: false, reason: 'over-limit' });
    expect(admission.check('queue-job', { remote: true })).toEqual({ allowed: true });
    running = 0;
    expect(admission.check('queue-job')).toEqual({ allowed: true });
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

  it('checks both load averages only on the light levels', () => {
    const admission = new WorkAdmission({ cpuCount: () => 4, loadAverage: () => [0, 4, 0] });
    admission.setWorkloadLevel(1);
    expect(admission.check('loop-round')).toMatchObject({ allowed: false, reason: 'computer-busy' });
    admission.setWorkloadLevel(5);
    expect(admission.check('loop-round')).toEqual({ allowed: true });
    expect(limitsFor(5, 18)).toMatchObject({ queueWorkerMinimum: 5, queueCheckMinimum: 3, queueLoadMinimum: 54, backgroundMultiplier: 2 });
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
});
