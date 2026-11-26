import { describe, expect, it, vi } from 'vitest';
import { recordLoopPause } from './loop-coordinator-state-helpers';

describe('recordLoopPause', () => {
  it('records the actual signal message ahead of a category reason', () => {
    const state: { endReason?: string } = {};
    expect(recordLoopPause({
      loopRunId: 'resource-loop', reason: 'resource-governor',
      signal: { message: 'Paused by resource governor: rss-above-critical' },
    }, () => state)).toEqual({
      loopRunId: 'resource-loop', reason: 'Paused by resource governor: rss-above-critical',
    });
    expect(state.endReason).toBe('Paused by resource governor: rss-above-critical');
  });

  it('uses an explicit reason or supplied diagnosis when no signal message exists', () => {
    const state: { endReason?: string } = {};
    recordLoopPause({ loopRunId: 'loop', reason: 'Waiting for input' }, () => state);
    expect(state.endReason).toBe('Waiting for input');
    recordLoopPause({ loopRunId: 'loop', nonConvergence: { message: 'Review repeated the same finding' } }, () => state);
    expect(state.endReason).toBe('Review repeated the same finding');
  });

  it('does not invent a reason or look up state without an identifier', () => {
    const findState = vi.fn();
    expect(recordLoopPause(undefined, findState)).toBeUndefined();
    expect(recordLoopPause({ reason: 'No run' }, findState)).toBeUndefined();
    expect(findState).not.toHaveBeenCalled();
    const state = { endReason: 'Earlier pause' as string | undefined };
    expect(recordLoopPause({ loopRunId: 'loop' }, () => state)).toEqual({ loopRunId: 'loop', reason: undefined });
    expect(state.endReason).toBeUndefined();
  });
});
