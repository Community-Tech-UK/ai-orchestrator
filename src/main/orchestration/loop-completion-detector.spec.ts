import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LoopCompletionDetector } from './loop-completion-detector';
import { defaultLoopConfig, type LoopIteration, type LoopState } from '../../shared/types/loop.types';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-completion-test-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

function makeIteration(over: Partial<LoopIteration> = {}): LoopIteration {
  return {
    id: 'iter',
    loopRunId: 'loop',
    seq: 0,
    stage: 'IMPLEMENT',
    startedAt: 0,
    endedAt: 0,
    childInstanceId: null,
    tokens: 0,
    costCents: 0,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    workHash: '',
    outputSimilarityToPrev: null,
    outputExcerpt: '',
    progressVerdict: 'OK',
    progressSignals: [],
    completionSignalsFired: [],
    verifyStatus: 'not-run',
    verifyOutputExcerpt: '',
    ...over,
  };
}

function makeState(workspaceCwd: string, over: Partial<LoopState> = {}): LoopState {
  const cfg = defaultLoopConfig(workspaceCwd, 'do thing');
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    config: cfg,
    status: 'running',
    startedAt: 0,
    endedAt: null,
    totalIterations: 0,
    totalTokens: 0,
    totalCostCents: 0,
    currentStage: 'IMPLEMENT',
    pendingInterventions: [],
    completedFileRenameObserved: false,
    tokensSinceLastTestImprovement: 0,
    highestTestPassCount: 0,
    iterationsOnCurrentStage: 0,
    recentWarnIterationSeqs: [],
    ...over,
  };
}

describe('LoopCompletionDetector.observe', () => {
  it('reports done-promise when output contains the marker', async () => {
    const det = new LoopCompletionDetector();
    const state = makeState(tmpDir);
    const iter = makeIteration({ outputExcerpt: 'I think we are done.\n<promise>DONE</promise>\n' });
    const sigs = await det.observe({ iteration: iter, config: state.config, state });
    expect(sigs.some((s) => s.id === 'done-promise' && s.sufficient)).toBe(true);
  });

  it('reports done-sentinel when DONE.txt exists', async () => {
    const det = new LoopCompletionDetector();
    fs.writeFileSync(path.join(tmpDir, 'DONE.txt'), 'finished');
    const state = makeState(tmpDir);
    const sigs = await det.observe({ iteration: makeIteration(), config: state.config, state });
    expect(sigs.some((s) => s.id === 'done-sentinel' && s.sufficient)).toBe(true);
  });

  it('reports plan-checklist when PLAN.md is fully checked', async () => {
    const det = new LoopCompletionDetector();
    fs.writeFileSync(
      path.join(tmpDir, 'PLAN.md'),
      '# Plan\n\n- [x] one\n- [x] two\n- [x] three\n',
    );
    const state = makeState(tmpDir, {
      config: { ...defaultLoopConfig(tmpDir, 'do thing'), planFile: 'PLAN.md' },
    });
    const sigs = await det.observe({ iteration: makeIteration(), config: state.config, state });
    expect(sigs.some((s) => s.id === 'plan-checklist' && s.sufficient)).toBe(true);
  });

  it('reports completed-rename via state when watcher observed it', async () => {
    const det = new LoopCompletionDetector();
    const state = makeState(tmpDir, { completedFileRenameObserved: true });
    const sigs = await det.observe({ iteration: makeIteration(), config: state.config, state });
    expect(sigs.some((s) => s.id === 'completed-rename' && s.sufficient)).toBe(true);
  });

  it('flags self-declared as auxiliary (sufficient: false)', async () => {
    const det = new LoopCompletionDetector();
    const state = makeState(tmpDir);
    const iter = makeIteration({ outputExcerpt: 'I have finished. TASK COMPLETE.' });
    const sigs = await det.observe({ iteration: iter, config: state.config, state });
    const self = sigs.find((s) => s.id === 'self-declared');
    expect(self?.sufficient).toBe(false);
  });
});

describe('LoopCompletionDetector.hasSufficientSignal', () => {
  it('true when any signal is sufficient', () => {
    const det = new LoopCompletionDetector();
    expect(det.hasSufficientSignal([
      { id: 'self-declared', sufficient: false, detail: '' },
      { id: 'done-promise', sufficient: true, detail: '' },
    ])).toBe(true);
  });

  it('false when none are sufficient', () => {
    const det = new LoopCompletionDetector();
    expect(det.hasSufficientSignal([
      { id: 'self-declared', sufficient: false, detail: '' },
    ])).toBe(false);
  });
});

describe('LoopCompletionDetector.passesBeltAndBraces', () => {
  it('false when require-rename is on and rename not observed', () => {
    const det = new LoopCompletionDetector();
    const state = makeState(tmpDir);
    expect(det.passesBeltAndBraces(state, state.config)).toBe(false);
  });

  it('true when require-rename is on and rename was observed', () => {
    const det = new LoopCompletionDetector();
    const state = makeState(tmpDir, { completedFileRenameObserved: true });
    expect(det.passesBeltAndBraces(state, state.config)).toBe(true);
  });

  it('true unconditionally when require-rename is off', () => {
    const det = new LoopCompletionDetector();
    const cfg = defaultLoopConfig(tmpDir, 'do thing');
    cfg.completion.requireCompletedFileRename = false;
    const state = makeState(tmpDir, { config: cfg });
    expect(det.passesBeltAndBraces(state, cfg)).toBe(true);
  });
});

describe('LoopCompletionDetector.runVerify', () => {
  it('skips when no command configured', async () => {
    const det = new LoopCompletionDetector();
    const cfg = defaultLoopConfig(tmpDir, 'x');
    cfg.completion.verifyCommand = '';
    const r = await det.runVerify(cfg);
    expect(r.status).toBe('passed');
  });

  it('passes when command exits 0', async () => {
    const det = new LoopCompletionDetector();
    const cfg = defaultLoopConfig(tmpDir, 'x');
    cfg.completion.verifyCommand = 'true';
    cfg.completion.verifyTimeoutMs = 5000;
    const r = await det.runVerify(cfg);
    expect(r.status).toBe('passed');
  });

  it('fails when command exits non-zero', async () => {
    const det = new LoopCompletionDetector();
    const cfg = defaultLoopConfig(tmpDir, 'x');
    cfg.completion.verifyCommand = 'false';
    cfg.completion.verifyTimeoutMs = 5000;
    const r = await det.runVerify(cfg);
    expect(r.status).toBe('failed');
  });
});
