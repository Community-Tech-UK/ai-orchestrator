import { describe, expect, it } from 'vitest';
import { authorizePlanQueueControl } from './plan-queue-control-authority';
import type { PlanQueueRun } from './plan-queue.types';
const run = { id: 'run', parentInstanceId: 'parent', workspaceCwd: '/repo' } as PlanQueueRun;
describe('routing authority', () => {
  it('allows only the parent or panel, even when the run is stranded', () => {
    const lookup = { instanceExists: (id: string) => id === 'rescuer', isQueueInstance: () => false, setAsideFolder: () => undefined };
    expect(authorizePlanQueueControl(run, 'set-routing', undefined, lookup)).toBe('James');
    expect(authorizePlanQueueControl(run, 'set-routing', 'parent', lookup)).toBe('James');
    expect(() => authorizePlanQueueControl(run, 'set-routing', 'rescuer', lookup)).toThrow('Only the session that started');
    expect(authorizePlanQueueControl(run, 'adopt', 'rescuer', lookup)).toContain('session rescuer');
  });
});

describe('discard authority', () => {
  const lookup = {
    instanceExists: () => true,
    isQueueInstance: (id: string) => id === 'worker',
    setAsideFolder: () => undefined,
  };

  it('lets any session the queue did not spawn discard or restore a job while the owner is alive, and names it', () => {
    expect(authorizePlanQueueControl(run, 'discard-item', 'other', lookup)).toBe('session other');
    expect(authorizePlanQueueControl(run, 'restore-discarded', 'other', lookup)).toBe('session other');
  });

  it('refuses a session the queue spawned', () => {
    expect(() => authorizePlanQueueControl(run, 'discard-item', 'worker', lookup)).toThrow('Only the session that started');
  });

  it('opens nothing else to that session', () => {
    expect(() => authorizePlanQueueControl(run, 'land-anyway', 'other', lookup)).toThrow('Only the session that started');
    expect(() => authorizePlanQueueControl(run, 'cancel', 'other', lookup)).toThrow('Only the session that started');
  });
});

describe('Set aside agent authority', () => {
  const lookup = {
    instanceExists: (id: string) => id === 'agent',
    isQueueInstance: () => false,
    setAsideFolder: (id: string) => (id === 'agent' ? '/repo' : undefined),
  };

  it('may skip, retry a merge, merge without checks, or resume, discard or restore a job in any folder, named in the audit trail', () => {
    for (const workspaceCwd of ['/repo', '/other']) {
      for (const action of ['skip-item', 'retry-landing', 'land-anyway', 'resume-item', 'discard-item', 'restore-discarded'] as const) {
        expect(authorizePlanQueueControl({ ...run, workspaceCwd }, action, 'agent', lookup)).toBe('the Set aside agent (session agent)');
      }
    }
  });

  it('is otherwise an ordinary session: it may ask for a handover or adopt a stranded run, but not reroute another owner\'s run', () => {
    expect(authorizePlanQueueControl(run, 'request-handover', 'agent', lookup)).toBe('session agent');
    expect(authorizePlanQueueControl(run, 'adopt', 'agent', lookup)).toContain('session agent');
    expect(authorizePlanQueueControl(run, 'cancel', 'agent', lookup)).toContain('no longer exists');
    const ownerAlive = { ...lookup, instanceExists: () => true };
    expect(() => authorizePlanQueueControl(run, 'adopt', 'agent', ownerAlive)).toThrow('still has a live parent');
    for (const action of ['cancel', 'set-routing', 'handover'] as const) {
      expect(() => authorizePlanQueueControl(run, action, 'agent', ownerAlive)).toThrow('Only the session that started');
    }
  });

  it('controls a run it owns as its owner, and is still named for its own job actions there', () => {
    const owned = { ...run, parentInstanceId: 'agent' };
    for (const action of ['set-routing', 'cancel', 'resume'] as const) expect(authorizePlanQueueControl(owned, action, 'agent', lookup)).toBe('James');
    for (const action of ['skip-item', 'discard-item', 'land-anyway'] as const) {
      expect(authorizePlanQueueControl(owned, action, 'agent', lookup)).toBe('the Set aside agent (session agent)');
    }
  });
});
