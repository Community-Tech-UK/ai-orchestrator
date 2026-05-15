import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CompletedFileWatcher, LoopCompletionDetector } from './loop-completion-detector';
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
    doneSentinelPresentAtStart: false,
    planChecklistFullyCheckedAtStart: false,
    uncompletedPlanFilesAtStart: [],
    tokensSinceLastTestImprovement: 0,
    highestTestPassCount: 0,
    iterationsOnCurrentStage: 0,
    recentWarnIterationSeqs: [],
    ...over,
  };
}

describe('LoopCompletionDetector.observe', () => {
  it('reports a nested configured plan-file completed rename even when the watcher missed it', async () => {
    const det = new LoopCompletionDetector();
    fs.mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'plans', 'phase.md'), '# Plan\n');
    const state = makeState(tmpDir, {
      startedAt: Date.now() - 1_000,
      config: {
        ...defaultLoopConfig(tmpDir, 'do thing'),
        planFile: 'docs/plans/phase.md',
      },
    });

    fs.renameSync(
      path.join(tmpDir, 'docs', 'plans', 'phase.md'),
      path.join(tmpDir, 'docs', 'plans', 'phase_completed.md'),
    );

    const sigs = await det.observe({
      iteration: makeIteration({ stage: 'IMPLEMENT' }),
      config: state.config,
      state,
    });

    const sig = sigs.find((s) => s.id === 'completed-rename');
    expect(sig).toBeDefined();
    expect(sig?.sufficient).toBe(true);
    expect(sig?.detail).toContain('docs/plans/phase_completed.md');
    expect(state.completedFileRenameObserved).toBe(true);
    expect(det.passesBeltAndBraces({ ...state }, { ...state.config, completion: { ...state.config.completion, requireCompletedFileRename: true } })).toBe(true);
  });

  it('treats a durable configured plan-file rename as sufficient even when the iteration started in REVIEW', async () => {
    const det = new LoopCompletionDetector();
    fs.mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'plans', 'phase.md'), '# Plan\n');
    const state = makeState(tmpDir, {
      startedAt: Date.now() - 1_000,
      config: {
        ...defaultLoopConfig(tmpDir, 'do thing'),
        planFile: 'docs/plans/phase.md',
      },
    });

    fs.renameSync(
      path.join(tmpDir, 'docs', 'plans', 'phase.md'),
      path.join(tmpDir, 'docs', 'plans', 'phase_Completed.md'),
    );

    const sigs = await det.observe({
      iteration: makeIteration({ stage: 'REVIEW' }),
      config: state.config,
      state,
    });

    expect(sigs.some((s) => s.id === 'completed-rename' && s.sufficient)).toBe(true);
  });

  it('does not treat a stale completed plan target as an in-run rename fallback', async () => {
    const det = new LoopCompletionDetector();
    fs.mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'plans', 'phase_completed.md'), '# Old completed plan\n');
    const state = makeState(tmpDir, {
      startedAt: Date.now() + 60_000,
      config: {
        ...defaultLoopConfig(tmpDir, 'do thing'),
        planFile: 'docs/plans/phase.md',
      },
    });

    const sigs = await det.observe({
      iteration: makeIteration({ stage: 'IMPLEMENT' }),
      config: state.config,
      state,
    });

    expect(sigs.find((s) => s.id === 'completed-rename')).toBeUndefined();
    expect(state.completedFileRenameObserved).toBe(false);
  });

  it('reports done-promise as auxiliary only when output contains the marker (IMPLEMENT stage)', async () => {
    const det = new LoopCompletionDetector();
    const state = makeState(tmpDir);
    const iter = makeIteration({ stage: 'IMPLEMENT', outputExcerpt: 'I think we are done.\n<promise>DONE</promise>\n' });
    const sigs = await det.observe({ iteration: iter, config: state.config, state });
    const sig = sigs.find((s) => s.id === 'done-promise');
    expect(sig).toBeDefined();
    expect(sig?.sufficient).toBe(false);
    expect(sig?.detail).toContain('waiting for durable completion evidence');
  });

  it('done-promise is NOT sufficient in PLAN stage', async () => {
    const det = new LoopCompletionDetector();
    const state = makeState(tmpDir);
    const iter = makeIteration({ stage: 'PLAN', outputExcerpt: '<promise>DONE</promise>' });
    const sigs = await det.observe({ iteration: iter, config: state.config, state });
    const sig = sigs.find((s) => s.id === 'done-promise');
    expect(sig).toBeDefined();
    expect(sig?.sufficient).toBe(false);
  });

  it('done-promise is NOT sufficient in REVIEW stage', async () => {
    const det = new LoopCompletionDetector();
    const state = makeState(tmpDir);
    const iter = makeIteration({ stage: 'REVIEW', outputExcerpt: '<promise>DONE</promise>' });
    const sigs = await det.observe({ iteration: iter, config: state.config, state });
    const sig = sigs.find((s) => s.id === 'done-promise');
    expect(sig).toBeDefined();
    expect(sig?.sufficient).toBe(false);
  });

  it('reports done-sentinel when DONE.txt is created during the run (IMPLEMENT stage)', async () => {
    const det = new LoopCompletionDetector();
    // Sentinel did NOT exist at startLoop — agent just created it.
    fs.writeFileSync(path.join(tmpDir, 'DONE.txt'), 'finished');
    const state = makeState(tmpDir, { doneSentinelPresentAtStart: false });
    const sigs = await det.observe({ iteration: makeIteration({ stage: 'IMPLEMENT' }), config: state.config, state });
    expect(sigs.some((s) => s.id === 'done-sentinel' && s.sufficient)).toBe(true);
  });

  it('does NOT report done-sentinel when DONE.txt already existed at startLoop (stale)', async () => {
    const det = new LoopCompletionDetector();
    fs.writeFileSync(path.join(tmpDir, 'DONE.txt'), 'left over from a prior run');
    const state = makeState(tmpDir, { doneSentinelPresentAtStart: true });
    const sigs = await det.observe({ iteration: makeIteration({ stage: 'IMPLEMENT' }), config: state.config, state });
    expect(sigs.find((s) => s.id === 'done-sentinel')).toBeUndefined();
  });

  it('done-sentinel is NOT sufficient in REVIEW stage even when in-run created', async () => {
    const det = new LoopCompletionDetector();
    fs.writeFileSync(path.join(tmpDir, 'DONE.txt'), 'finished');
    const state = makeState(tmpDir, { doneSentinelPresentAtStart: false });
    const sigs = await det.observe({ iteration: makeIteration({ stage: 'REVIEW' }), config: state.config, state });
    const sig = sigs.find((s) => s.id === 'done-sentinel');
    expect(sig).toBeDefined();
    expect(sig?.sufficient).toBe(false);
  });

  it('reports plan-checklist when PLAN.md becomes fully checked during the run (IMPLEMENT stage)', async () => {
    const det = new LoopCompletionDetector();
    fs.writeFileSync(
      path.join(tmpDir, 'PLAN.md'),
      '# Plan\n\n- [x] one\n- [x] two\n- [x] three\n',
    );
    // Plan was NOT fully checked at startLoop — agent ticked the last box.
    const state = makeState(tmpDir, {
      config: { ...defaultLoopConfig(tmpDir, 'do thing'), planFile: 'PLAN.md' },
      planChecklistFullyCheckedAtStart: false,
    });
    const sigs = await det.observe({ iteration: makeIteration({ stage: 'IMPLEMENT' }), config: state.config, state });
    expect(sigs.some((s) => s.id === 'plan-checklist' && s.sufficient)).toBe(true);
  });

  it('does NOT report plan-checklist when PLAN.md was already fully checked at startLoop (stale)', async () => {
    const det = new LoopCompletionDetector();
    fs.writeFileSync(
      path.join(tmpDir, 'PLAN.md'),
      '# Plan\n\n- [x] one\n- [x] two\n- [x] three\n',
    );
    const state = makeState(tmpDir, {
      config: { ...defaultLoopConfig(tmpDir, 'do thing'), planFile: 'PLAN.md' },
      planChecklistFullyCheckedAtStart: true,
    });
    const sigs = await det.observe({ iteration: makeIteration({ stage: 'IMPLEMENT' }), config: state.config, state });
    expect(sigs.find((s) => s.id === 'plan-checklist')).toBeUndefined();
  });

  it('plan-checklist is NOT sufficient in PLAN stage', async () => {
    const det = new LoopCompletionDetector();
    fs.writeFileSync(
      path.join(tmpDir, 'PLAN.md'),
      '# Plan\n\n- [x] one\n- [x] two\n',
    );
    const state = makeState(tmpDir, {
      config: { ...defaultLoopConfig(tmpDir, 'do thing'), planFile: 'PLAN.md' },
      planChecklistFullyCheckedAtStart: false,
    });
    const sigs = await det.observe({ iteration: makeIteration({ stage: 'PLAN' }), config: state.config, state });
    const sig = sigs.find((s) => s.id === 'plan-checklist');
    expect(sig).toBeDefined();
    expect(sig?.sufficient).toBe(false);
  });

  it('reports completed-rename via state when watcher observed it (IMPLEMENT stage)', async () => {
    const det = new LoopCompletionDetector();
    const state = makeState(tmpDir, { completedFileRenameObserved: true });
    const sigs = await det.observe({ iteration: makeIteration({ stage: 'IMPLEMENT' }), config: state.config, state });
    expect(sigs.some((s) => s.id === 'completed-rename' && s.sufficient)).toBe(true);
  });

  it('completed-rename from the in-run watcher is sufficient in REVIEW stage because the durable rename is stronger than the stage hint', async () => {
    const det = new LoopCompletionDetector();
    const state = makeState(tmpDir, { completedFileRenameObserved: true });
    const sigs = await det.observe({ iteration: makeIteration({ stage: 'REVIEW' }), config: state.config, state });
    const sig = sigs.find((s) => s.id === 'completed-rename');
    expect(sig).toBeDefined();
    expect(sig?.sufficient).toBe(true);
  });

  it('flags self-declared as auxiliary (sufficient: false)', async () => {
    const det = new LoopCompletionDetector();
    const state = makeState(tmpDir);
    const iter = makeIteration({ outputExcerpt: 'I have finished. TASK COMPLETE.' });
    const sigs = await det.observe({ iteration: iter, config: state.config, state });
    const self = sigs.find((s) => s.id === 'self-declared');
    expect(self?.sufficient).toBe(false);
  });

  it('reports explicit loop-control complete intent as a sufficient declared-complete signal', async () => {
    const det = new LoopCompletionDetector();
    const state = makeState(tmpDir, {
      terminalIntentPending: {
        id: 'intent-1',
        loopRunId: 'loop-1',
        iterationSeq: 0,
        kind: 'complete',
        summary: 'implementation complete',
        evidence: [],
        source: 'loop-control-cli',
        createdAt: 1,
        receivedAt: 2,
        status: 'pending',
      },
    });
    const sigs = await det.observe({ iteration: makeIteration({ stage: 'REVIEW' }), config: state.config, state });
    const signal = sigs.find((s) => s.id === 'declared-complete');
    expect(signal).toMatchObject({
      sufficient: true,
      detail: expect.stringContaining('implementation complete'),
    });
  });
});

describe('CompletedFileWatcher', () => {
  it('observes completed files added in configured nested directories', async () => {
    const nestedDir = path.join(tmpDir, 'docs', 'plans');
    fs.mkdirSync(nestedDir, { recursive: true });
    const watcher = new CompletedFileWatcher(tmpDir, '*_[Cc]ompleted.md', [nestedDir]);
    const observed = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for nested completed file event')), 2_000);
      watcher.onCompleted((filePath) => {
        clearTimeout(timeout);
        resolve(filePath);
      });
    });

    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.writeFileSync(path.join(nestedDir, 'phase_completed.md'), '# Done\n');

    try {
      await expect(observed).resolves.toBe(path.join(nestedDir, 'phase_completed.md'));
    } finally {
      await watcher.stop();
    }
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
    state.config.completion.requireCompletedFileRename = true;
    expect(det.passesBeltAndBraces(state, state.config)).toBe(false);
  });

  it('true when require-rename is on and rename was observed', () => {
    const det = new LoopCompletionDetector();
    const state = makeState(tmpDir, { completedFileRenameObserved: true });
    state.config.completion.requireCompletedFileRename = true;
    expect(det.passesBeltAndBraces(state, state.config)).toBe(true);
  });

  it('true by default when no explicit completed-file rename is required', () => {
    const det = new LoopCompletionDetector();
    const cfg = defaultLoopConfig(tmpDir, 'do thing');
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
    // No command => the loop verified NOTHING. It must report 'skipped'
    // (not 'passed') so the coordinator refuses to stop the loop on an
    // unverified, self-declared completion.
    expect(r.status).toBe('skipped');
    expect(r.output).toContain('no verify command');
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
