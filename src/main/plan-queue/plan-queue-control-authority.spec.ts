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

describe('Set aside agent authority', () => {
  const lookup = {
    instanceExists: (id: string) => id === 'agent',
    isQueueInstance: () => false,
    setAsideFolder: (id: string) => (id === 'agent' ? '/repo' : undefined),
  };

  it('may retry a merge or resume a job in its own folder, named in the audit trail', () => {
    expect(authorizePlanQueueControl(run, 'retry-landing', 'agent', lookup)).toContain('the Set aside agent');
    expect(authorizePlanQueueControl(run, 'resume-item', 'agent', lookup)).toContain('the Set aside agent');
  });

  it('may not land without checks, discard one job or take over a run, even a stranded one', () => {
    for (const action of ['land-anyway', 'discard-item', 'adopt', 'cancel', 'set-routing', 'handover', 'request-handover'] as const) {
      expect(() => authorizePlanQueueControl(run, action, 'agent', lookup)).toThrow('may only retry a merge or resume');
    }
  });

  it('may not touch another folder', () => {
    expect(() => authorizePlanQueueControl({ ...run, workspaceCwd: '/other' }, 'resume-item', 'agent', lookup)).toThrow('its own folder');
  });

  it('keeps those limits when it is the recorded parent', () => {
    expect(() => authorizePlanQueueControl({ ...run, parentInstanceId: 'agent' }, 'land-anyway', 'agent', lookup)).toThrow('may only retry');
  });
});
