import { describe, it, expect } from 'vitest';
import { LoopPreflightResultSchema } from '../loop-audit.schemas';

/**
 * Schema-vs-type drift regression guard: `LoopPreflightResult['commands'][].failureKind`
 * in src/shared/types/loop-audit.types.ts allows 'command' | 'timeout' | 'infra' |
 * 'environment' | 'cancelled', but the contracts schema only enumerated the first
 * three, silently dropping a real runtime value (an aborted preflight verify child
 * reports 'cancelled'; an isolated-environment failure reports 'environment') on
 * any IPC round-trip.
 */
describe('LoopPreflightResultSchema — commands[].failureKind drift guard', () => {
  const base = {
    status: 'failed' as const,
    ranAt: 1,
    commands: [{
      label: 'verify' as const,
      command: 'npm test',
      status: 'failed' as const,
      durationMs: 10,
      outputExcerpt: 'boom',
    }],
  };

  it.each(['command', 'timeout', 'infra', 'environment', 'cancelled'] as const)(
    'accepts %s as a command failureKind',
    (failureKind) => {
      const parsed = LoopPreflightResultSchema.parse({
        ...base,
        commands: [{ ...base.commands[0], failureKind }],
      });
      expect(parsed.commands[0]?.failureKind).toBe(failureKind);
    },
  );

  it('rejects an undocumented failureKind', () => {
    expect(() => LoopPreflightResultSchema.parse({
      ...base,
      commands: [{ ...base.commands[0], failureKind: 'bogus' }],
    })).toThrow();
  });
});
