import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import { getSupervisorTree, SupervisorTree } from '../process/supervisor-tree';
import { adoptInstance, type InstanceAdoptionDeps } from './instance-adoption';

function makeInstance(id: string, parentId: string | null = null): Instance {
  return { id, parentId, childrenIds: [], depth: 0, status: 'idle' } as unknown as Instance;
}

function setup(...instances: Instance[]): { deps: InstanceAdoptionDeps; byId: Map<string, Instance> } {
  const byId = new Map(instances.map((instance) => [instance.id, instance]));
  for (const instance of instances) {
    getSupervisorTree().registerInstance(instance.id, instance.parentId, '/repo', instance.id);
  }
  return {
    byId,
    deps: {
      getInstance: (id) => byId.get(id),
      reparentOrchestration: vi.fn(),
      queueUpdate: vi.fn(),
    },
  };
}

describe('adoptInstance', () => {
  beforeEach(async () => {
    await SupervisorTree._resetForTesting();
  });

  it('gives a parentless session every parent link creation would have', () => {
    const { deps, byId } = setup(makeInstance('parent'), makeInstance('worker'));

    expect(adoptInstance(deps, 'worker', 'parent')).toBe(true);

    expect(byId.get('worker')!.parentId).toBe('parent');
    expect(byId.get('worker')!.depth).toBe(1);
    expect(byId.get('parent')!.childrenIds).toEqual(['worker']);
    expect(getSupervisorTree().getInstanceRegistration('worker')?.parentId).toBe('parent');
    expect(getSupervisorTree().getChildInstances('parent')).toEqual(['worker']);
    expect(deps.reparentOrchestration).toHaveBeenCalledWith('worker', 'parent');
    expect(deps.queueUpdate).toHaveBeenCalledWith(byId.get('worker'));
  });

  it('moves the adopted session\'s own children down the tree with it', () => {
    const subAgent = { ...makeInstance('sub-agent', 'worker'), depth: 1 };
    const worker = { ...makeInstance('worker'), childrenIds: ['sub-agent'] };
    const parent = { ...makeInstance('parent', 'root'), depth: 1 };
    const { deps } = setup(makeInstance('root'), parent, worker, subAgent);

    expect(adoptInstance(deps, 'worker', 'parent')).toBe(true);

    expect([worker.depth, subAgent.depth]).toEqual([2, 3]);
  });

  it('moves a session from an edit-superseded parent to its replacement', () => {
    const source = { ...makeInstance('source'), status: 'superseded', childrenIds: ['worker'] } as Instance;
    const { deps, byId } = setup(source, makeInstance('replacement'), makeInstance('worker', 'source'));

    expect(adoptInstance(deps, 'worker', 'replacement')).toBe(true);

    expect(byId.get('worker')!.parentId).toBe('replacement');
    expect(source.childrenIds).toEqual([]);
    expect(byId.get('replacement')!.childrenIds).toEqual(['worker']);
  });

  it('refuses a session that already has a parent', () => {
    const { deps, byId } = setup(makeInstance('parent'), makeInstance('other'), makeInstance('worker', 'other'));

    expect(adoptInstance(deps, 'worker', 'parent')).toBe(false);
    expect(byId.get('worker')!.parentId).toBe('other');
    expect(byId.get('parent')!.childrenIds).toEqual([]);
    expect(deps.queueUpdate).not.toHaveBeenCalled();
  });

  it('refuses a missing session, itself, and its own descendant as parent', () => {
    const { deps, byId } = setup(makeInstance('worker'), makeInstance('grandchild', 'child'), makeInstance('child', 'worker'));

    expect(adoptInstance(deps, 'worker', 'gone')).toBe(false);
    expect(adoptInstance(deps, 'gone', 'worker')).toBe(false);
    expect(adoptInstance(deps, 'worker', 'worker')).toBe(false);
    expect(adoptInstance(deps, 'worker', 'grandchild')).toBe(false);
    expect(byId.get('worker')!.parentId).toBeNull();
    expect(deps.reparentOrchestration).not.toHaveBeenCalled();
  });
});
