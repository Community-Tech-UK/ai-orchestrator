import { describe, expect, it } from 'vitest';
import { authorizePlanQueueControl } from './plan-queue-control-authority';
import type { PlanQueueRun } from './plan-queue.types';
const run = { id: 'run', parentInstanceId: 'parent' } as PlanQueueRun;
describe('routing authority', () => {
  it('allows only the parent or panel, even when the run is stranded', () => {
    const lookup = { instanceExists: (id: string) => id === 'rescuer', isQueueInstance: () => false };
    expect(authorizePlanQueueControl(run, 'set-routing', undefined, lookup)).toBe('James');
    expect(authorizePlanQueueControl(run, 'set-routing', 'parent', lookup)).toBe('James');
    expect(() => authorizePlanQueueControl(run, 'set-routing', 'rescuer', lookup)).toThrow('Only the session that started');
    expect(authorizePlanQueueControl(run, 'adopt', 'rescuer', lookup)).toContain('session rescuer');
  });
});
