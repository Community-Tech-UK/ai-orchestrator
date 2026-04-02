import { describe, it, expect, vi } from 'vitest';
import { StartupOptimizer, type StartupTask } from './startup-optimizer';

describe('StartupOptimizer', () => {
  it('runs independent tasks in parallel', async () => {
    const startTimes: Record<string, number> = {};
    const tasks: StartupTask[] = [
      { name: 'taskA', phase: 'immediate', fn: async () => { startTimes['taskA'] = Date.now(); await new Promise(r => setTimeout(r, 50)); } },
      { name: 'taskB', phase: 'immediate', fn: async () => { startTimes['taskB'] = Date.now(); await new Promise(r => setTimeout(r, 50)); } },
    ];
    const optimizer = new StartupOptimizer(tasks);
    await optimizer.runPhase('immediate');
    expect(Math.abs(startTimes['taskA'] - startTimes['taskB'])).toBeLessThan(30);
  });

  it('defers tasks to later phases', async () => {
    const executed: string[] = [];
    const tasks: StartupTask[] = [
      { name: 'critical', phase: 'immediate', fn: async () => { executed.push('critical'); } },
      { name: 'deferred', phase: 'afterFirstRender', fn: async () => { executed.push('deferred'); } },
    ];
    const optimizer = new StartupOptimizer(tasks);
    await optimizer.runPhase('immediate');
    expect(executed).toEqual(['critical']);
    await optimizer.runPhase('afterFirstRender');
    expect(executed).toEqual(['critical', 'deferred']);
  });

  it('captures errors without blocking other tasks', async () => {
    const tasks: StartupTask[] = [
      { name: 'fail', phase: 'immediate', fn: async () => { throw new Error('boom'); } },
      { name: 'succeed', phase: 'immediate', fn: async () => 'ok' },
    ];
    const optimizer = new StartupOptimizer(tasks);
    const results = await optimizer.runPhase('immediate');
    expect(results.find(r => r.name === 'fail')?.error).toBe('boom');
    expect(results.find(r => r.name === 'succeed')?.success).toBe(true);
  });

  it('tracks timing for each task', async () => {
    const tasks: StartupTask[] = [
      { name: 'fast', phase: 'immediate', fn: async () => { await new Promise(r => setTimeout(r, 10)); } },
    ];
    const optimizer = new StartupOptimizer(tasks);
    const results = await optimizer.runPhase('immediate');
    expect(results[0].durationMs).toBeGreaterThanOrEqual(5);
  });
});
