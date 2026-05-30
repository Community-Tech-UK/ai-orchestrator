/**
 * LF-4 (loopfixex.md) — LOOP_TASKS.md ledger as the completion authority in the
 * detector. While the ledger has open items NO signal is sufficient (a
 * premature DONE.txt can't stop a half-done run); when every item is
 * done/deferred, `ledger-complete` becomes the (sufficient) stop signal.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCompletionDetector } from './loop-completion-detector';
import { defaultLoopConfig, type LoopIteration, type LoopState } from '../../shared/types/loop.types';

let tmpDir: string;
let det: LoopCompletionDetector;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'loop-ledger-'));
  det = new LoopCompletionDetector();
});
afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

function makeState(over: Partial<LoopState> = {}): LoopState {
  const config = defaultLoopConfig(tmpDir, 'do the thing');
  return {
    id: 'loop-1', chatId: 'chat-1', config, status: 'running',
    startedAt: 0, endedAt: null, totalIterations: 0, totalTokens: 0, totalCostCents: 0,
    currentStage: 'IMPLEMENT', pendingInterventions: [],
    completedFileRenameObserved: false, doneSentinelPresentAtStart: false,
    planChecklistFullyCheckedAtStart: false, uncompletedPlanFilesAtStart: [],
    loopTasksLedgerResolvedAtStart: false, manualReviewOnly: false,
    tokensSinceLastTestImprovement: 0, highestTestPassCount: 0,
    iterationsOnCurrentStage: 0, recentWarnIterationSeqs: [], completionAttempts: 0,
    ...over,
  };
}

function makeIteration(over: Partial<LoopIteration> = {}): LoopIteration {
  return {
    id: 'iter-1', loopRunId: 'loop-1', seq: 0, stage: 'IMPLEMENT', startedAt: 0, endedAt: 1,
    childInstanceId: null, tokens: 1, costCents: 0, filesChanged: [], toolCalls: [], errors: [],
    testPassCount: null, testFailCount: null, workHash: 'h', outputSimilarityToPrev: null,
    // Emit DONE.txt-style markers so we can prove the ledger demotes them.
    outputExcerpt: 'TASK COMPLETE\n<promise>DONE</promise>', progressVerdict: 'OK',
    progressSignals: [], completionSignalsFired: [], verifyStatus: 'not-run', verifyOutputExcerpt: '',
    ...over,
  };
}

describe('LoopCompletionDetector — LOOP_TASKS.md ledger (LF-4)', () => {
  it('blocks completion while the ledger has open items (demotes other signals)', async () => {
    writeFileSync(join(tmpDir, 'DONE.txt'), 'done\n'); // a normally-sufficient signal
    writeFileSync(join(tmpDir, 'LOOP_TASKS.md'), '- [x] one\n- [ ] two\n');
    const state = makeState();

    const sigs = await det.observe({ iteration: makeIteration(), config: state.config, state });

    // No signal is sufficient while item "two" is open.
    expect(det.hasSufficientSignal(sigs)).toBe(false);
    const sentinel = sigs.find((s) => s.id === 'done-sentinel');
    expect(sentinel?.sufficient).toBe(false);
    const ledger = sigs.find((s) => s.id === 'ledger-complete');
    expect(ledger?.sufficient).toBe(false);
    expect(ledger?.detail).toContain('open item');
  });

  it('fires ledger-complete (sufficient) once every item is done/deferred', async () => {
    writeFileSync(join(tmpDir, 'LOOP_TASKS.md'), '- [x] one\n- [-] two — deferred: out of scope\n');
    const state = makeState();

    const sigs = await det.observe({ iteration: makeIteration(), config: state.config, state });

    const ledger = sigs.find((s) => s.id === 'ledger-complete');
    expect(ledger).toBeDefined();
    expect(ledger?.sufficient).toBe(true);
    expect(det.hasSufficientSignal(sigs)).toBe(true);
  });

  it('ignores a ledger that was already fully resolved at start (stale)', async () => {
    writeFileSync(join(tmpDir, 'DONE.txt'), 'done\n'); // normal sufficient signal
    writeFileSync(join(tmpDir, 'LOOP_TASKS.md'), '- [x] one\n- [x] two\n');
    const state = makeState({ loopTasksLedgerResolvedAtStart: true });

    const sigs = await det.observe({ iteration: makeIteration(), config: state.config, state });

    // The stale resolved ledger contributes no ledger-complete signal; the
    // normal DONE.txt sentinel is free to act as before.
    expect(sigs.find((s) => s.id === 'ledger-complete')).toBeUndefined();
    expect(sigs.find((s) => s.id === 'done-sentinel')?.sufficient).toBe(true);
  });

  it('is a no-op when LOOP_TASKS.md is absent or has no items', async () => {
    writeFileSync(join(tmpDir, 'DONE.txt'), 'done\n');
    writeFileSync(join(tmpDir, 'LOOP_TASKS.md'), '# Loop Tasks\n\njust a heading, no checkboxes\n');
    const state = makeState();

    const sigs = await det.observe({ iteration: makeIteration(), config: state.config, state });

    expect(sigs.find((s) => s.id === 'ledger-complete')).toBeUndefined();
    expect(sigs.find((s) => s.id === 'done-sentinel')?.sufficient).toBe(true);
  });
});
