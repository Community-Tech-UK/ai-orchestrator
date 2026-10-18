import { describe, expect, it } from 'vitest';
import { LoopStatusSchema } from '@contracts/schemas/loop';
import { MOBILE_LOOP_STATUSES } from '../../shared/types/mobile-gateway.types';
import { attentionLevelForLoopStatus } from '../../shared/attention/attention-level';
import { loopStatusToPhase } from '../../shared/types/workflow-lifecycle.types';
import { isActiveLoopRuntimeState, isParkedLoopRuntimeState, isTerminalLoopRuntimeState } from './loop-runtime-status';
import { isLoopTerminal, loopStatusToNodeStatus } from './campaign-loop-status';

describe('loop terminal contract', () => {
  it('covers every wire status in runtime and campaign terminality, including the provider-limit split', () => {
    expect([...MOBILE_LOOP_STATUSES].sort()).toEqual([...LoopStatusSchema.options].sort());
    for (const status of LoopStatusSchema.options) {
      for (const endedAt of [null, 123]) {
        const state = { status, endedAt };
        const terminal = !['running', 'paused'].includes(status)
          && !(status === 'provider-limit' && endedAt === null);
        expect(isTerminalLoopRuntimeState(state), `${status}/${endedAt}`).toBe(terminal);
        expect(isLoopTerminal(state), `${status}/${endedAt}`).toBe(terminal);
      }
    }
  });

  it('projects failed attempts as ended failures and never as resumable work', () => {
    const state = { status: 'attempt-failed' as const, endedAt: 123 };
    expect(isActiveLoopRuntimeState(state)).toBe(false);
    expect(isParkedLoopRuntimeState(state)).toBe(false);
    expect(loopStatusToNodeStatus(state.status)).toBe('failed');
    expect(attentionLevelForLoopStatus(state.status, state.endedAt)).toBe('failed');
    expect(loopStatusToPhase(state.status)).toBe('failed');
  });
});
