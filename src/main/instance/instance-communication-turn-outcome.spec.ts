import { describe, expect, it } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import { resolveSettledTurnOutcome } from './instance-communication.constants';

describe('resolveSettledTurnOutcome', () => {
  it.each([
    [undefined, undefined, 'completed'],
    ['timed-out', undefined, 'completed'],
    ['requested', undefined, 'interrupted'],
    ['accepted', undefined, 'interrupted'],
    ['completed', undefined, 'interrupted'],
    ['accepted', 'cancelled', 'cancelled'],
    ['escalated', undefined, 'cancelled'],
  ] as const)('resolves %s after %s to %s', (interruptPhase, lastTurnOutcome, expected) => {
    const instance = { interruptPhase, lastTurnOutcome } as Pick<Instance, 'interruptPhase' | 'lastTurnOutcome'>;
    expect(resolveSettledTurnOutcome(instance)).toBe(expected);
  });
});
