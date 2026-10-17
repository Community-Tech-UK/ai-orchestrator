import { describe, expect, it } from 'vitest';
import type { InstanceStatus } from '../../shared/types/instance.types';
import { createInstanceManagerHostProcessHooks } from './host-process-instance-hooks';

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
});
