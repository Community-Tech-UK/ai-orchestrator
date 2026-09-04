import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { prepareLoopIterationPrompt, shouldIncludeSessionReplay } from './loop-iteration-prompt';
import { LoopStageMachine } from './loop-stage-machine';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';

const REPLAY_MARKER = 'old parent chat marker';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-iteration-prompt-'));
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

/**
 * Minimal LoopState for the prompt seam. `prepareLoopIterationPrompt` only
 * reads config/usage/ledger fields plus the two recycle markers; model routing
 * is best-effort and already fails closed inside its own try/catch.
 */
function stateFor(overrides: Partial<LoopState> = {}): LoopState {
  return {
    config: defaultLoopConfig(tmpDir, 'My persistent loop goal'),
    totalTokens: 0,
    totalCostCents: 0,
    uncompletedPlanFilesAtStart: [],
    manualReviewOnly: false,
    ...overrides,
  } as LoopState;
}

async function prepare(seq: number, state: LoopState, pendingContextReset = false) {
  return prepareLoopIterationPrompt({
    reviewDriven: false,
    stageMachine: new LoopStageMachine(tmpDir, 'loop-prompt-test'),
    state,
    seq,
    drainNowInterventions: [],
    existingSessionContext: REPLAY_MARKER,
    crossModelReviewEnabled: false,
    pendingContextReset,
    appendLoopControlPrompt: (text) => text,
  });
}

describe('shouldIncludeSessionReplay (T15)', () => {
  it('sends the parent-chat replay on the first iteration', () => {
    expect(shouldIncludeSessionReplay({
      iterationSeq: 0,
      pendingContextReset: false,
      justCompacted: false,
    })).toBe(true);
  });

  it('skips the replay on later iterations', () => {
    expect(shouldIncludeSessionReplay({
      iterationSeq: 1,
      pendingContextReset: false,
      justCompacted: false,
    })).toBe(false);
    expect(shouldIncludeSessionReplay({
      iterationSeq: 42,
      pendingContextReset: false,
      justCompacted: false,
    })).toBe(false);
  });

  it('re-sends the replay when a context reset is scheduled for this iteration', () => {
    expect(shouldIncludeSessionReplay({
      iterationSeq: 4,
      pendingContextReset: true,
      justCompacted: false,
    })).toBe(true);
  });

  it('re-sends the replay on the iteration after a recycle', () => {
    expect(shouldIncludeSessionReplay({
      iterationSeq: 4,
      pendingContextReset: false,
      justCompacted: true,
    })).toBe(true);
  });
});

describe('prepareLoopIterationPrompt session replay seam', () => {
  it('carries the parent-chat replay into the iteration 0 prompt', async () => {
    const { prompt, freshSessionPrompt } = await prepare(0, stateFor());
    expect(prompt).toContain(REPLAY_MARKER);
    // Nothing extra to build on iteration 0 — the replay is already there.
    expect(freshSessionPrompt).toBe(prompt);
  });

  it('drops the replay on a later iteration', async () => {
    const { prompt } = await prepare(4, stateFor());
    expect(prompt).not.toContain(REPLAY_MARKER);
  });

  it('re-sends the replay on the iteration after a recycle', async () => {
    const { prompt } = await prepare(4, stateFor({ justCompacted: { seq: 3, reason: 'overflow' } }));
    expect(prompt).toContain(REPLAY_MARKER);
  });

  it('re-sends the replay when a context reset is scheduled for this iteration', async () => {
    const { prompt } = await prepare(4, stateFor(), true);
    expect(prompt).toContain(REPLAY_MARKER);
  });

  it('exposes a fresh-session prompt with both the goal and the replay for a mid-attempt forced reset', async () => {
    // Iteration 4, no recycle marker: the normal prompt deliberately omits the
    // replay, but a forced reset (overflow recovery / breaker backoff /
    // degraded retry) puts the child in a brand-new session that has neither
    // the goal nor the replay. `freshSessionPrompt` is what the coordinator
    // swaps in there.
    const { prompt, freshSessionPrompt } = await prepare(4, stateFor());
    expect(prompt).not.toContain(REPLAY_MARKER);
    expect(freshSessionPrompt).toContain(REPLAY_MARKER);
    expect(freshSessionPrompt).toContain('My persistent loop goal');
    expect(freshSessionPrompt).not.toBe(prompt);
  });
});
