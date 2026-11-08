import { describe, expect, it } from 'vitest';
import type { PersonTurnCheck } from '../instance/input-turn-registry';
import { authorizeLandAnyway, type LandAnywayPort } from './plan-queue-land-anyway-authority';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

const PARKED_AT = 1_000_000;
const TYPED_AT = new Date(2026, 10, 4, 14, 2, 30).getTime();
const run = { id: 'run-1', parentInstanceId: 'parent' } as PlanQueueRun;
const item = { id: 'item-1' } as PlanQueueItem;

function port(overrides: Partial<LandAnywayPort> & { turn?: PersonTurnCheck } = {}): LandAnywayPort {
  const { turn, ...rest } = overrides;
  return {
    isQueueInstance: (id) => id.startsWith('worker'),
    instanceExists: () => true,
    checkPersonTurn: () => turn ?? { ok: true, messageId: 'msg-7', typedAt: TYPED_AT },
    lastParkedAt: () => PARKED_AT,
    ...rest,
  };
}

describe('authorizeLandAnyway', () => {
  it('lets the Plan Queue page land, and names it', () => {
    expect(authorizeLandAnyway(run, item, undefined, port({ turn: { ok: false, reason: 'no-input' } }))).toEqual({
      by: 'from the Plan Queue page', reference: { actor: 'page' },
    });
  });

  it('lets the parent land in the turn a person\'s message started after the item parked, and names the message and time, not its text', () => {
    const approval = authorizeLandAnyway(run, item, 'parent', port());
    expect(approval.by).toBe('by the session that started the run, after James\'s message at 14:02');
    expect(approval.reference).toEqual({ actor: 'session', instanceId: 'parent', messageId: 'msg-7', typedAt: TYPED_AT });
  });

  it.each([
    ['provider-cannot-report', /can't report when a turn starts/],
    ['no-input', /no message from James in this session/],
    ['latest-input-not-person', /wasn't a message James typed or spoke/],
    ['turn-not-started', /hasn't seen a turn start/],
    ['another-turn-started', /Another turn has started since/],
  ] as const)('refuses the parent when the check says %s, with a plain reason', (reason, message) => {
    expect(() => authorizeLandAnyway(run, item, 'parent', port({ turn: { ok: false, reason } }))).toThrow(message);
  });

  it('refuses a message from before the item parked, and one at the very moment it parked', () => {
    expect(() => authorizeLandAnyway(run, item, 'parent', port({ turn: { ok: true, messageId: 'm', typedAt: PARKED_AT - 1 } })))
      .toThrow(/before this item parked/);
    expect(() => authorizeLandAnyway(run, item, 'parent', port({ turn: { ok: true, messageId: 'm', typedAt: PARKED_AT } })))
      .toThrow(/before this item parked/);
    expect(authorizeLandAnyway(run, item, 'parent', port({ turn: { ok: true, messageId: 'm', typedAt: PARKED_AT + 1 } })).reference)
      .toMatchObject({ actor: 'session' });
  });

  it('refuses when the queue has no record of the park time', () => {
    expect(() => authorizeLandAnyway(run, item, 'parent', port({ lastParkedAt: () => null }))).toThrow(/no record of when this item parked/);
  });

  it('refuses a queue worker or checker, even a person-driven one', () => {
    expect(() => authorizeLandAnyway(run, item, 'worker-1', port())).toThrow(/queue worker or checker can't land work/);
    expect(() => authorizeLandAnyway({ ...run, parentInstanceId: 'worker-1' }, item, 'worker-1', port())).toThrow(/queue worker or checker/);
  });

  it('refuses the stranded-run rescuer, and points to adopt', () => {
    expect(() => authorizeLandAnyway(run, item, 'rescuer', port({ instanceExists: (id) => id !== 'parent' })))
      .toThrow(/isn't a rescue action[\s\S]*Use action "adopt"/);
  });

  it('refuses another session while the parent lives', () => {
    expect(() => authorizeLandAnyway(run, item, 'other', port())).toThrow(/Only the session that started this Plan Queue run/);
  });

  it('never asks the person check when the caller is not the parent', () => {
    const calls: string[] = [];
    const watching = port({ checkPersonTurn: (id) => { calls.push(id); return { ok: true, messageId: 'm', typedAt: TYPED_AT }; } });
    expect(() => authorizeLandAnyway(run, item, 'other', watching)).toThrow();
    expect(calls).toEqual([]);
  });
});
