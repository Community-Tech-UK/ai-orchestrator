import { describe, expect, it } from 'vitest';
import {
  shouldReanchorLoopGoal,
  recordLoopThreadCaps,
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
      lastFullAnchorSeq: 0,
      iterationSeq: 0,
      lastThreadCaps: claudeResident,
      pendingContextReset: false,
      justCompacted: false,
      thisAttemptModel: claudeResident.model,
    })).toBe(true);
  });

  it('skips the goal for Claude resident / Codex same-thread, same model, iter > 0', () => {
    expect(shouldReanchorLoopGoal({
      lastFullAnchorSeq: 0,
      iterationSeq: 1,
      lastThreadCaps: claudeResident,
      pendingContextReset: false,
      justCompacted: false,
      thisAttemptModel: claudeResident.model,
    })).toBe(false);
  });

  it('re-anchors after recycle / justCompacted', () => {
    expect(shouldReanchorLoopGoal({
      lastFullAnchorSeq: 0,
      iterationSeq: 2,
      lastThreadCaps: claudeResident,
      pendingContextReset: false,
      justCompacted: true,
      thisAttemptModel: claudeResident.model,
    })).toBe(true);
  });

  it('re-anchors on pending context reset', () => {
    expect(shouldReanchorLoopGoal({
      lastFullAnchorSeq: 0,
      iterationSeq: 2,
      lastThreadCaps: claudeResident,
      pendingContextReset: true,
      justCompacted: false,
      thisAttemptModel: claudeResident.model,
    })).toBe(true);
  });

  it('keeps the goal for resume-without-continuation (Copilot exec, Cursor CLI, ACP loadSession)', () => {
    expect(shouldReanchorLoopGoal({
      lastFullAnchorSeq: 0,
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
      lastFullAnchorSeq: 0,
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
      lastFullAnchorSeq: 0,
      iterationSeq: 1,
      lastThreadCaps: { ...claudeResident, model: 'claude-opus-4-6' },
      pendingContextReset: false,
      justCompacted: false,
      thisAttemptModel: 'claude-sonnet-4-6',
    })).toBe(true);
  });

  it('fails closed when the snapshot or this-attempt model is missing', () => {
    expect(shouldReanchorLoopGoal({
      lastFullAnchorSeq: 0,
      iterationSeq: 1,
      lastThreadCaps: undefined,
      pendingContextReset: false,
      justCompacted: false,
      thisAttemptModel: 'claude-sonnet-4-6',
    })).toBe(true);
    expect(shouldReanchorLoopGoal({
      lastFullAnchorSeq: 0,
      iterationSeq: 1,
      lastThreadCaps: { ...claudeResident, model: null },
      pendingContextReset: false,
      justCompacted: false,
      thisAttemptModel: 'claude-sonnet-4-6',
    })).toBe(true);
    expect(shouldReanchorLoopGoal({
      lastFullAnchorSeq: 0,
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

 describe('A3 native resume and compaction proof', () => {
  const base = { getRuntimeCapabilities: () => ({ supportsResume: true }), getContextCapabilities: () => ({ sameThreadContinuation: false }), willResumeSession: () => true };
  it('accepts only confirmed non-forked native resume of the exact session', () => {
    const result = { source: 'native', confirmed: true, requestedSessionId: 'same', actualSessionId: 'same', forked: false };
    expect(snapshotLoopThreadCaps({ ...base, getResumeAttemptResult: () => result }, 'model')?.sameThreadContinuation).toBe(true);
    for (const change of [{ confirmed: false }, { forked: true }, { source: 'fresh-fallback' }, { actualSessionId: 'different' }, { requestedSessionId: undefined }]) {
      expect(snapshotLoopThreadCaps({ ...base, willResumeSession: () => !('source' in change), getResumeAttemptResult: () => ({ ...result, ...change }) }, 'model')?.sameThreadContinuation).toBe(false);
    }
  });
  it('keeps ACP and Codex exec without the Claude resume-eligibility surface unchanged', () => {
    const adapter = {
      getRuntimeCapabilities: () => ({ supportsResume: true }),
      getContextCapabilities: () => ({ sameThreadContinuation: false }),
      getResumeAttemptResult: () => ({ source: 'native', confirmed: true, requestedSessionId: 'same', actualSessionId: 'same' }),
    };
    expect(snapshotLoopThreadCaps(adapter, 'model')?.sameThreadContinuation).toBe(false);
    expect(snapshotLoopThreadCaps({ ...adapter, willResumeSession: () => false }, 'model')?.sameThreadContinuation).toBe(false);
  });

  it('accepts a first fresh round whose session will resume, but never bypasses a failed native attempt', () => {
    expect(snapshotLoopThreadCaps({ ...base, willResumeSession: () => true, getResumeAttemptResult: () => ({ source: 'fresh-fallback', confirmed: false }) }, 'model')?.sameThreadContinuation).toBe(true);
    expect(snapshotLoopThreadCaps({ ...base, willResumeSession: () => true, getResumeAttemptResult: () => ({ source: 'native', confirmed: false }) }, 'model')?.sameThreadContinuation).toBe(false);
  });
  it('clears the stored proof when the provider compacted during the turn', () => {
    const state = { lastThreadCaps: claudeResident as LoopThreadCaps | undefined };
    const caps = snapshotLoopThreadCaps({ ...base, getTurnCompaction: () => ({ count: 1 }) }, 'model');
    recordLoopThreadCaps(state, { threadCaps: caps });
    expect(state.lastThreadCaps).toBeUndefined();
  });
  it('reanchors at ten rounds and fails closed for legacy or invalid checkpoints', () => {
    const input = { iterationSeq: 9, lastFullAnchorSeq: 0, lastThreadCaps: claudeResident, pendingContextReset: false, justCompacted: false, thisAttemptModel: claudeResident.model };
    expect(shouldReanchorLoopGoal(input)).toBe(false);
    expect(shouldReanchorLoopGoal({ ...input, iterationSeq: 10 })).toBe(true);
    expect(shouldReanchorLoopGoal({ ...input, iterationSeq: 11, lastFullAnchorSeq: 10 })).toBe(false);
    expect(shouldReanchorLoopGoal({ ...input, lastFullAnchorSeq: undefined })).toBe(true);
    expect(shouldReanchorLoopGoal({ ...input, lastFullAnchorSeq: NaN })).toBe(true);
    expect(shouldReanchorLoopGoal({ ...input, lastFullAnchorSeq: 12 })).toBe(true);
  });
});
