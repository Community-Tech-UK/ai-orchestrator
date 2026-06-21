/**
 * Investigation/audit completion gate (goalIntent === 'investigation').
 *
 * A loop whose goal is a question/audit must produce a substantive,
 * file:line-cited REPORT.md before ANY completion signal is accepted. Without
 * this gate an investigation loop could "complete" on a bare DONE.txt with no
 * answer delivered — the silent-reframe failure the goalIntent split prevents.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LoopCompletionDetector,
  isSubstantiveInvestigationReport,
} from './loop-completion-detector';
import { resolveLoopArtifactPaths, loopStateFile, type LoopArtifactPaths } from './loop-artifact-paths';
import { INVESTIGATION_REPORT_FILE } from './loop-stage-machine';
import { defaultLoopConfig, type LoopIteration, type LoopState } from '../../shared/types/loop.types';

const RUN_ID = 'loop-1';
let tmpDir: string;
let paths: LoopArtifactPaths;
let det: LoopCompletionDetector;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'loop-investigation-'));
  paths = resolveLoopArtifactPaths(tmpDir, RUN_ID);
  mkdirSync(paths.dir, { recursive: true });
  det = new LoopCompletionDetector();
});
afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

function makeState(over: Partial<LoopState> = {}): LoopState {
  const config = defaultLoopConfig(tmpDir, 'Is this fully implemented?');
  config.goalIntent = 'investigation';
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
    outputExcerpt: 'TASK COMPLETE\n<promise>DONE</promise>',
    outputFull: 'TASK COMPLETE\n<promise>DONE</promise>', progressVerdict: 'OK',
    progressSignals: [], completionSignalsFired: [], verifyStatus: 'not-run', verifyOutputExcerpt: '',
    ...over,
  };
}

const GOOD_REPORT =
  '# Audit: Is this fully implemented?\n\n' +
  'A1 models.dev catalog — DONE. The picker consumes the unified store at ' +
  'src/renderer/app/features/models/compact-model-picker.component.ts:191, and the ' +
  'freshness pill is wired at src/main/orchestration/loop-coordinator.ts:630. ' +
  'A6 scripted adapter — PARTIAL: receipt bus exists but no Playwright E2E.\n';

describe('LoopCompletionDetector — investigation REPORT.md gate', () => {
  it('blocks completion when REPORT.md is missing (demotes the DONE.txt sentinel)', async () => {
    writeFileSync(loopStateFile(paths, 'DONE.txt'), 'done\n'); // normally sufficient
    const state = makeState();

    const sigs = await det.observe({ iteration: makeIteration(), config: state.config, state });

    expect(det.hasSufficientSignal(sigs)).toBe(false);
    expect(sigs.find((s) => s.id === 'done-sentinel')?.sufficient).toBe(false);
    expect(sigs.some((s) => s.detail.includes(INVESTIGATION_REPORT_FILE))).toBe(true);
  });

  it('blocks completion when REPORT.md exists but has no file:line citation', async () => {
    writeFileSync(loopStateFile(paths, 'DONE.txt'), 'done\n');
    writeFileSync(
      loopStateFile(paths, INVESTIGATION_REPORT_FILE),
      '# Audit\n\nEverything looks done to me, the code seems complete and fine.\n',
    );
    const state = makeState();

    const sigs = await det.observe({ iteration: makeIteration(), config: state.config, state });

    expect(det.hasSufficientSignal(sigs)).toBe(false);
  });

  it('allows completion once REPORT.md is substantive and cited', async () => {
    writeFileSync(loopStateFile(paths, 'DONE.txt'), 'done\n');
    writeFileSync(loopStateFile(paths, INVESTIGATION_REPORT_FILE), GOOD_REPORT);
    const state = makeState();

    const sigs = await det.observe({ iteration: makeIteration(), config: state.config, state });

    expect(sigs.find((s) => s.id === 'done-sentinel')?.sufficient).toBe(true);
    expect(det.hasSufficientSignal(sigs)).toBe(true);
  });

  it('does NOT gate an implementation loop on REPORT.md', async () => {
    writeFileSync(loopStateFile(paths, 'DONE.txt'), 'done\n');
    const state = makeState();
    state.config.goalIntent = 'implementation';

    const sigs = await det.observe({ iteration: makeIteration(), config: state.config, state });

    // No REPORT.md on disk, but an implement loop is unaffected.
    expect(sigs.find((s) => s.id === 'done-sentinel')?.sufficient).toBe(true);
  });
});

describe('isSubstantiveInvestigationReport', () => {
  it('rejects empty, stub, and uncited reports', () => {
    expect(isSubstantiveInvestigationReport('')).toBe(false);
    expect(isSubstantiveInvestigationReport('# Report\n\nTODO')).toBe(false);
    // Long enough but no file:line citation.
    expect(isSubstantiveInvestigationReport('x '.repeat(200))).toBe(false);
  });

  it('accepts a substantive report with at least one file:line citation', () => {
    expect(isSubstantiveInvestigationReport(GOOD_REPORT)).toBe(true);
  });
});
