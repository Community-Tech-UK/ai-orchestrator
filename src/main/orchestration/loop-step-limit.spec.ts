import { describe, expect, it } from 'vitest';
import { stepLimitNote, maybeQueueStepLimitContinuation } from './loop-step-limit';
import type { LoopConfig, LoopIteration, LoopState } from '../../shared/types/loop.types';
describe('step limit continuation', () => {
  it('advertises only enforced Claude limits', () => {
    expect(stepLimitNote({ provider: 'claude', maxTurnsPerIteration: 30 } as LoopConfig)).toContain('turn 24');
    expect(stepLimitNote({ provider: 'claude', maxTurnsPerIteration: 7 } as LoopConfig)).toContain('turn 5');
    for (const config of [{ provider:'codex', maxTurnsPerIteration:30 },{ provider:'claude', maxTurnsPerIteration:0 }]) expect(stepLimitNote(config as LoopConfig)).toBe('');
  });
  it('queues once without using idle budgets and honors operator/completion input', () => {
    const state = { config: {provider: 'claude',maxTurnsPerIteration: 3}, pendingInterventions: [], idleNudgeCount: 1 } as unknown as LoopState;
    const iteration = { finishReason: 'max_turns', completionSignalsFired: [] } as unknown as LoopIteration;
    expect(maybeQueueStepLimitContinuation(state, iteration)).toBe(true);
    expect(state.pendingInterventions[0].source).toBe('step-limit'); expect(state.idleNudgeCount).toBe(1);
    expect(maybeQueueStepLimitContinuation(state, iteration)).toBe(false);
    state.pendingInterventions=[]; iteration.completionSignalsFired=[{sufficient:true} as never];
    expect(maybeQueueStepLimitContinuation(state, iteration)).toBe(false);
  });
});
