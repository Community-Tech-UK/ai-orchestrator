import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogManager } from '../logging/logger';
import { HibernationManager, type HibernatedInstance } from './hibernation-manager';
import { runIdleHibernationSweep } from './idle-hibernation-sweep';
import { JitterScheduler } from '../tasks/jitter-scheduler';
const state = vi.hoisted(() => ({
  manager: null as LogManager | null
}));
vi.mock('../logging/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logging/logger')>();
  state.manager = new actual.LogManager({
    enableConsole: false,
    enableFile: false,
    globalLevel: 'debug'
  });
  return {
    ...actual,
    getLogger: (name: string) => state.manager!.getLogger(name)
  };
});
const marker = 'LOCAL_HIBERNATION_SOURCE_SENTINEL';
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item instanceof Error
    ? Object.fromEntries(Object.getOwnPropertyNames(item).map(key => [key, Reflect.get(item, key)])) : item);
}
beforeEach(() => {
  state.manager!.clearBuffer();
});
afterEach(() => {
  vi.restoreAllMocks();
  HibernationManager._resetForTesting();
  JitterScheduler._resetForTesting();
});
describe('real hibernation and sweep diagnostic boundaries', () => {
  it('keeps exact saved title/state/native event while logging a bounded title diagnostic', () => {
    const manager = HibernationManager.getInstance();
    const saved: HibernatedInstance = {
      instanceId: 'LOCAL_HIBERNATION_INSTANCE',
      displayName: marker,
      agentId: 'build',
      sessionState: {
        source: marker
      },
      hibernatedAt: Date.now()
    };
    const events: HibernatedInstance[] = [];
    manager.on('instance:hibernated', value => events.push(value));
    const log = vi.spyOn(state.manager!, 'log');
    const logError = vi.spyOn(state.manager!, 'logError');
    manager.markHibernated(saved.instanceId, saved);
    expect(manager.getHibernatedState(saved.instanceId)).toBe(saved);
    expect(events).toEqual([saved]);
    expect(events[0]).toBe(saved);
    const rows = state.manager!.getRecentLogs();
    expect(rows.some(row => row.message === 'Instance hibernated')).toBe(true);
    expect(serialize(rows)).not.toContain(marker);
    expect(serialize([log.mock.calls, logError.mock.calls])).not.toContain(marker);
  });
  it.each([false, true])('keeps the exact sweep callback result and source-bearing rejection with failure=%s', async (failing) => {
    const manager = HibernationManager.getInstance();
    const now = Date.now();
    const originalError = Object.assign(new Error(marker), {
      cause: new Error(marker),
      metadata: {
        source: marker
      }
    });
    const saved: HibernatedInstance = {
      instanceId: 'LOCAL_SWEEP_INSTANCE',
      displayName: marker,
      agentId: 'build',
      sessionState: {},
      hibernatedAt: now
    };
    const attempts: Promise<void>[] = [];
    const events: HibernatedInstance[] = [];
    manager.on('instance:hibernated', value => events.push(value));
    const hibernate = vi.fn((id: string): Promise<void> => {
      const result = failing ? Promise.reject(originalError) : Promise.resolve().then(() => {
        manager.markHibernated(id, saved);
      });
      attempts.push(result);
      return result;
    });
    const log = vi.spyOn(state.manager!, 'log');
    const logError = vi.spyOn(state.manager!, 'logError');
    runIdleHibernationSweep({
      hibernation: manager,
      getInstances: () => [{
          id: saved.instanceId,
          displayName: marker,
          status: 'idle',
          parentId: null,
          isRemote: false,
          lastActivity: now - 45 * 60000
        }],
      getIdleMinutes: () => 30,
      hibernateInstance: hibernate,
      now: () => now
    });
    expect(hibernate).toHaveBeenCalledExactlyOnceWith(saved.instanceId);
    expect(await Promise.allSettled(attempts)).toEqual(failing ? [{
        status: 'rejected',
        reason: originalError
      }] : [{
        status: 'fulfilled',
        value: undefined
      }]);
    expect(events).toEqual(failing ? [] : [saved]);
    expect(manager.isHibernated(saved.instanceId)).toBe(!failing);
    if (!failing)
      expect(manager.getHibernatedState(saved.instanceId)).toBe(saved);
    const rows = state.manager!.getRecentLogs();
    expect(rows.some(row => row.message === 'Auto-hibernating idle root session')).toBe(true);
    expect(rows.some(row => row.message === 'Failed to hibernate idle root session')).toBe(failing);
    expect(serialize(rows)).not.toContain(marker);
    expect(serialize([log.mock.calls, logError.mock.calls])).not.toContain(marker);
  });
});
