import { describe, expect, it } from 'vitest';
import type { InstanceStatus } from '../../shared/types/instance.types';
import { createInstanceManagerHostProcessHooks, liveSessionRoots, sessionOwnerState } from './host-process-instance-hooks';

describe('createInstanceManagerHostProcessHooks', () => {
  const instances = new Map<string, { id: string; status: InstanceStatus; processId: number | null }>([
    ['busy', { id: 'busy', status: 'busy', processId: 100 }],
    ['hibernated', { id: 'hibernated', status: 'hibernated', processId: null }],
    ['terminated', { id: 'terminated', status: 'terminated', processId: null }],
    ['failed', { id: 'failed', status: 'failed', processId: null }],
    ['codex', { id: 'codex', status: 'idle', processId: null }],
  ]);
  const hooks = createInstanceManagerHostProcessHooks({
    getInstance: (id) => instances.get(id),
    getAllInstances: () => [...instances.values()],
    getAdapter: (id) => (id === 'codex' ? { getPid: () => 200 } : id === 'busy' ? { getPid: () => { throw new Error('x'); } } : undefined),
  });

  it('treats only unknown, terminated and failed sessions as not live', () => {
    expect(hooks.isInstanceLive('busy')).toBe(true);
    expect(hooks.isInstanceLive('hibernated')).toBe(true);
    expect(hooks.isInstanceLive('terminated')).toBe(false);
    expect(hooks.isInstanceLive('failed')).toBe(false);
    expect(hooks.isInstanceLive('never-existed')).toBe(false);
  });

  it('collects instance and adapter pids, tolerating a throwing adapter', () => {
    expect([...hooks.getLiveSessionPids()].sort()).toEqual([100, 200]);
  });

  it('uses only running adapter pids of sessions that have not ended as lineage roots', () => {
    const source = {
      getInstance: (id: string) => instances.get(id),
      getAllInstances: () => [...instances.values()],
      getAdapter: (id: string) => ({ codex: { getPid: () => 200 }, terminated: { getPid: () => 300 } } as Record<string, unknown>)[id],
    };
    // `busy` has a stored processId but no running adapter pid; `terminated` still reports a pid.
    expect([...liveSessionRoots(source)]).toEqual([[200, 'codex']]);
  });

  it('tells ended sessions apart from ones this run does not know', () => {
    const source = { getInstance: (id: string) => instances.get(id), getAllInstances: () => [], getAdapter: () => undefined };
    expect(sessionOwnerState(source, 'hibernated')).toBe('live');
    expect(sessionOwnerState(source, 'failed')).toBe('ended');
    expect(sessionOwnerState(source, 'terminated')).toBe('ended');
    expect(sessionOwnerState(source, 'from-another-app')).toBe('unknown');
  });
});
