import { describe, it, expect } from 'vitest';
import { LoopActivityKindSchema } from '../loop.schemas';
import { LoopActivityEventSchema } from '../loop-events.schemas';

/**
 * LT-021 regression guard.
 *
 * The main process forwards its whole `LoopInvocationActivity` vocabulary on
 * the `loop:activity` push channel. When this schema accepted only
 * `status | error | input_required`, renderer event validation silently blocked
 * the other eight kinds — so the loop activity feed never showed a tool call,
 * a tool result or the completion of an iteration.
 */
describe('LoopActivityEventSchema', () => {
  const base = {
    loopRunId: 'loop-1',
    seq: 0,
    stage: 'IMPLEMENT' as const,
    timestamp: 1,
    message: 'x',
  };

  /**
   * Pinned literally rather than read from `LoopActivityKindSchema`. Iterating
   * the schema's own options against a schema whose `kind` field *is* that
   * schema can never fail — it looks like a guard and guards nothing. This list
   * is the emitter's vocabulary (`LoopInvocationActivityKind`); if the two ever
   * diverge again, this fails.
   */
  const EMITTED_KINDS = [
    'spawned', 'status', 'tool_use', 'tool_result', 'assistant', 'system',
    'input_required', 'error', 'stream-idle', 'complete', 'heartbeat',
  ] as const;

  it('accepts every kind the main process can emit', () => {
    for (const kind of EMITTED_KINDS) {
      const parsed = LoopActivityEventSchema.safeParse({ ...base, kind });
      expect(parsed.success, `kind "${kind}" must be accepted`).toBe(true);
    }
  });

  it('the shared union covers exactly the emitted kinds — no drift either way', () => {
    expect([...LoopActivityKindSchema.options].sort()).toEqual([...EMITTED_KINDS].sort());
  });

  it('accepts a representative tool_use and tool_result payload', () => {
    expect(LoopActivityEventSchema.safeParse({
      ...base,
      kind: 'tool_use',
      message: 'Using tool: Read',
      detail: { name: 'Read' },
    }).success).toBe(true);

    expect(LoopActivityEventSchema.safeParse({
      ...base,
      kind: 'tool_result',
      message: 'Read finished',
      detail: { name: 'Read', success: true },
    }).success).toBe(true);
  });

  it('still rejects a kind outside the shared union', () => {
    expect(LoopActivityEventSchema.safeParse({ ...base, kind: 'not-a-kind' }).success).toBe(false);
  });
});
