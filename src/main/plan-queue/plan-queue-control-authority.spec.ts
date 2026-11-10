import { describe, expect, it } from 'vitest';
import { authorizePlanQueueControl } from './plan-queue-control-authority';
import type { PersonTurnCheck } from '../instance/input-turn-registry';
import type { PlanQueueRun } from './plan-queue.types';
const noPersonTurn = (): PersonTurnCheck => ({ ok: false, reason: 'latest-input-not-person' });
const run = { id: 'run', parentInstanceId: 'parent', workspaceCwd: '/repo' } as PlanQueueRun;
describe('routing authority', () => {
  it('allows only the parent or panel, even when the run is stranded', () => {
    const lookup = { instanceExists: (id: string) => id === 'rescuer', isQueueInstance: () => false, setAsideFolder: () => undefined, checkPersonTurn: noPersonTurn };
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
    checkPersonTurn: noPersonTurn,
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
    checkPersonTurn: noPersonTurn,
  };
  const askedByJames = { ...lookup, checkPersonTurn: (): PersonTurnCheck => ({ ok: true, messageId: 'm1', typedAt: new Date(2026, 10, 10, 17, 5).getTime() }) };

  it('may skip a job in its own folder only in its reply to a message James typed, named with that message', () => {
    expect(authorizePlanQueueControl(run, 'skip-item', 'agent', askedByJames))
      .toBe("the Set aside agent (session agent), after James's message at 17:05");
    expect(() => authorizePlanQueueControl(run, 'skip-item', 'agent', lookup)).toThrow('in its reply to a message James typed');
    const silentProvider = { ...lookup, checkPersonTurn: (): PersonTurnCheck => ({ ok: false, reason: 'provider-cannot-report' }) };
    expect(() => authorizePlanQueueControl(run, 'skip-item', 'agent', silentProvider)).toThrow("can't report when a turn starts");
    expect(() => authorizePlanQueueControl({ ...run, workspaceCwd: '/other' }, 'skip-item', 'agent', askedByJames)).toThrow('may only retry a merge');
  });

  it("gains nothing else from James's message", () => {
    for (const action of ['adopt', 'cancel', 'set-routing', 'handover', 'request-handover'] as const) {
      expect(() => authorizePlanQueueControl(run, action, 'agent', askedByJames)).toThrow('may only retry a merge, resume a job');
    }
  });

  it('may retry a merge, merge without checks, or resume, discard or restore a job, named in the audit trail', () => {
    for (const action of ['retry-landing', 'land-anyway', 'resume-item', 'discard-item', 'restore-discarded'] as const) {
      expect(authorizePlanQueueControl(run, action, 'agent', lookup)).toContain('the Set aside agent');
    }
  });

  it('may not take over a run, even a stranded one', () => {
    for (const action of ['adopt', 'cancel', 'set-routing', 'handover', 'request-handover'] as const) {
      expect(() => authorizePlanQueueControl(run, action, 'agent', lookup)).toThrow('may only retry a merge, resume a job');
    }
  });

  it('may not retry, merge or resume in another folder, but may discard or restore there', () => {
    const elsewhere = { ...run, workspaceCwd: '/other' };
    for (const action of ['resume-item', 'retry-landing', 'land-anyway'] as const) {
      expect(() => authorizePlanQueueControl(elsewhere, action, 'agent', lookup)).toThrow('its own folder');
    }
    for (const action of ['discard-item', 'restore-discarded'] as const) {
      expect(authorizePlanQueueControl(elsewhere, action, 'agent', lookup)).toContain('the Set aside agent');
    }
  });

  it('keeps those limits when it is the recorded parent', () => {
    expect(() => authorizePlanQueueControl({ ...run, parentInstanceId: 'agent' }, 'cancel', 'agent', lookup)).toThrow('may only retry');
  });
});
