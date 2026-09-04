import { describe, expect, it } from 'vitest';
import {
  shouldReanchorLoopGoal,
  snapshotLoopThreadCaps,
  type LoopThreadCaps,
} from './loop-goal-reanchor';

const claudeResident: LoopThreadCaps = {
  supportsResume: true,
  sameThreadContinuation: true,
  model: 'claude-sonnet-4-6',
};

describe('shouldReanchorLoopGoal (T2 locked skip predicate)', () => {
  it('always re-anchors iteration 0', () => {
    expect(shouldReanchorLoopGoal({
      iterationSeq: 0,
      lastThreadCaps: claudeResident,
      pendingContextReset: false,
      justCompacted: false,
      thisAttemptModel: claudeResident.model,
    })).toBe(true);
  });

  it('skips the goal for Claude resident / Codex same-thread, same model, iter > 0', () => {
    expect(shouldReanchorLoopGoal({
      iterationSeq: 1,
      lastThreadCaps: claudeResident,
      pendingContextReset: false,
      justCompacted: false,
      thisAttemptModel: claudeResident.model,
    })).toBe(false);
  });

  it('re-anchors after recycle / justCompacted', () => {
    expect(shouldReanchorLoopGoal({
      iterationSeq: 2,
      lastThreadCaps: claudeResident,
      pendingContextReset: false,
      justCompacted: true,
      thisAttemptModel: claudeResident.model,
    })).toBe(true);
  });

  it('re-anchors on pending context reset', () => {
    expect(shouldReanchorLoopGoal({
      iterationSeq: 2,
      lastThreadCaps: claudeResident,
      pendingContextReset: true,
      justCompacted: false,
      thisAttemptModel: claudeResident.model,
    })).toBe(true);
  });

  it('keeps the goal for resume-without-continuation (Copilot exec, Cursor CLI, ACP loadSession)', () => {
    expect(shouldReanchorLoopGoal({
      iterationSeq: 3,
      lastThreadCaps: {
        supportsResume: true,
        sameThreadContinuation: false,
        model: 'gpt-5.5',
      },
      pendingContextReset: false,
      justCompacted: false,
      thisAttemptModel: 'gpt-5.5',
    })).toBe(true);
  });

  it('keeps the goal for Gemini / Antigravity (no resume)', () => {
    expect(shouldReanchorLoopGoal({
      iterationSeq: 4,
      lastThreadCaps: {
        supportsResume: false,
        sameThreadContinuation: false,
        model: 'gemini-flash',
      },
      pendingContextReset: false,
      justCompacted: false,
      thisAttemptModel: 'gemini-flash',
    })).toBe(true);
  });

  it('re-anchors when the resolved model differs (G22)', () => {
    expect(shouldReanchorLoopGoal({
      iterationSeq: 1,
      lastThreadCaps: { ...claudeResident, model: 'claude-opus-4-6' },
      pendingContextReset: false,
      justCompacted: false,
      thisAttemptModel: 'claude-sonnet-4-6',
    })).toBe(true);
  });

  it('fails closed when the snapshot or this-attempt model is missing', () => {
    expect(shouldReanchorLoopGoal({
      iterationSeq: 1,
      lastThreadCaps: undefined,
      pendingContextReset: false,
      justCompacted: false,
      thisAttemptModel: 'claude-sonnet-4-6',
    })).toBe(true);
    expect(shouldReanchorLoopGoal({
      iterationSeq: 1,
      lastThreadCaps: { ...claudeResident, model: null },
      pendingContextReset: false,
      justCompacted: false,
      thisAttemptModel: 'claude-sonnet-4-6',
    })).toBe(true);
    expect(shouldReanchorLoopGoal({
      iterationSeq: 1,
      lastThreadCaps: claudeResident,
      pendingContextReset: false,
      justCompacted: false,
      thisAttemptModel: null,
    })).toBe(true);
  });
});

describe('snapshotLoopThreadCaps', () => {
  it('reads resume + continuation from the adapter without inventing a model', () => {
    const adapter = {
      getRuntimeCapabilities: () => ({ supportsResume: true }),
      getContextCapabilities: () => ({ sameThreadContinuation: true }),
    };
    expect(snapshotLoopThreadCaps(adapter, 'claude-sonnet-4-6')).toEqual(claudeResident);
    expect(snapshotLoopThreadCaps(adapter, undefined)).toEqual({
      supportsResume: true,
      sameThreadContinuation: true,
      model: null,
    });
    expect(snapshotLoopThreadCaps({}, 'x')).toBeUndefined();
  });
});
