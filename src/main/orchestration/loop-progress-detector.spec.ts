import { describe, it, expect } from 'vitest';
import {
  LoopProgressDetector,
  signalA_identicalWorkHash,
  signalB_editChurn,
  signalC_stageStagnation,
  signalD_testOscillation,
  signalDPrime_testStagnationWithWrites,
  signalE_errorRepeat,
  signalF_tokenBurn,
  signalG_toolRepetition,
  signalH_outputSimilarity,
  signalI_idempotentReadIdentity,
} from './loop-progress-detector';
import {
  defaultLoopConfig,
  type LoopIteration,
  type LoopProgressThresholds,
  type LoopState,
} from '../../shared/types/loop.types';

const cfg = defaultLoopConfig('/tmp/test', 'do the thing');
const T: LoopProgressThresholds = cfg.progressThresholds;

function makeIteration(over: Partial<LoopIteration> = {}): LoopIteration {
  return {
    id: 'iter-1',
    loopRunId: 'loop-1',
    seq: 0,
    stage: 'IMPLEMENT',
    startedAt: 0,
    endedAt: 0,
    childInstanceId: null,
    tokens: 1000,
    costCents: 0,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    workHash: 'hash-default',
    outputSimilarityToPrev: null,
    outputExcerpt: 'some output',
    outputFull: 'some output',
    progressVerdict: 'OK',
    progressSignals: [],
    completionSignalsFired: [],
    verifyStatus: 'not-run',
    verifyOutputExcerpt: '',
    ...over,
  };
}

function makeState(over: Partial<LoopState> = {}): LoopState {
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
    manualReviewOnly: false,
    tokensSinceLastTestImprovement: 0,
    highestTestPassCount: 0,
    iterationsOnCurrentStage: 0,
    recentWarnIterationSeqs: [],
    completionAttempts: 0,
    loopTasksLedgerResolvedAtStart: false,
    ...over,
  };
}

describe('signal A — identical work hash', () => {
  it('returns null when no repeats', () => {
    const history = [makeIteration({ workHash: 'a' })];
    const current = makeIteration({ workHash: 'b' });
    expect(signalA_identicalWorkHash(history, current, T)).toBeNull();
  });

  it('WARN at 2 consecutive identical', () => {
    const history = [makeIteration({ workHash: 'X' })];
    const current = makeIteration({ workHash: 'X' });
    const sig = signalA_identicalWorkHash(history, current, T);
    expect(sig?.verdict).toBe('WARN');
  });

  it('CRITICAL at 3 consecutive identical', () => {
    const history = [
      makeIteration({ workHash: 'X' }),
      makeIteration({ workHash: 'X' }),
    ];
    const current = makeIteration({ workHash: 'X' });
    const sig = signalA_identicalWorkHash(history, current, T);
    expect(sig?.verdict).toBe('CRITICAL');
  });

  it('CRITICAL at 3 of last 5 windowed', () => {
    const history = [
      makeIteration({ workHash: 'X' }),
      makeIteration({ workHash: 'Y' }),
      makeIteration({ workHash: 'X' }),
      makeIteration({ workHash: 'Z' }),
    ];
    const current = makeIteration({ workHash: 'X' });
    const sig = signalA_identicalWorkHash(history, current, T);
    expect(sig?.verdict).toBe('CRITICAL');
  });
});

describe('signal B — edit churn (A→B→A)', () => {
  it('null when nothing edited', () => {
    expect(signalB_editChurn([], makeIteration(), T)).toBeNull();
  });

  it('CRITICAL when same file goes A→B→A', () => {
    const history = [
      makeIteration({ filesChanged: [{ path: 'a.ts', additions: 1, deletions: 0, contentHash: 'aaa' }] }),
      makeIteration({ filesChanged: [{ path: 'a.ts', additions: 1, deletions: 1, contentHash: 'bbb' }] }),
    ];
    const current = makeIteration({ filesChanged: [{ path: 'a.ts', additions: 1, deletions: 1, contentHash: 'aaa' }] });
    const sig = signalB_editChurn(history, current, T);
    expect(sig?.verdict).toBe('CRITICAL');
  });
});

describe('signal C — stage stagnation', () => {
  it('warns when iterations on stage exceed warn', () => {
    const state = makeState({ currentStage: 'PLAN', iterationsOnCurrentStage: T.stageWarnIterations.PLAN });
    const sig = signalC_stageStagnation(state, T);
    expect(sig?.verdict).toBe('WARN');
  });
  it('critical when iterations on stage exceed critical', () => {
    const state = makeState({ currentStage: 'PLAN', iterationsOnCurrentStage: T.stageCriticalIterations.PLAN });
    const sig = signalC_stageStagnation(state, T);
    expect(sig?.verdict).toBe('CRITICAL');
  });
});

describe('signal D — test oscillation', () => {
  it('CRITICAL on strict alternation', () => {
    const history = [
      makeIteration({ testPassCount: 5 }),
      makeIteration({ testPassCount: 7 }),
      makeIteration({ testPassCount: 5 }),
      makeIteration({ testPassCount: 7 }),
    ];
    const current = makeIteration({ testPassCount: 5 });
    const sig = signalD_testOscillation(history, current);
    expect(sig?.verdict).toBe('CRITICAL');
  });

  it('WARN on noisy directions (3 flips in 4 deltas)', () => {
    const history = [
      makeIteration({ testPassCount: 5 }),
      makeIteration({ testPassCount: 7 }),
      makeIteration({ testPassCount: 6 }),
      makeIteration({ testPassCount: 8 }),
    ];
    const current = makeIteration({ testPassCount: 4 });
    const sig = signalD_testOscillation(history, current);
    expect(sig?.verdict).toBe('WARN');
  });

  it('null on monotonic improvement', () => {
    const history = [
      makeIteration({ testPassCount: 1 }),
      makeIteration({ testPassCount: 2 }),
      makeIteration({ testPassCount: 3 }),
      makeIteration({ testPassCount: 4 }),
    ];
    const current = makeIteration({ testPassCount: 5 });
    expect(signalD_testOscillation(history, current)).toBeNull();
  });
});

describe('signal D-prime — test stagnation with file writes', () => {
  it('returns null when every iteration has null testPassCount', () => {
    const fileWrite = { path: 'x', additions: 1, deletions: 0, contentHash: 'h' };
    const history = Array.from({ length: T.testStagnationCriticalIterations - 1 }, (_, i) =>
      makeIteration({ seq: i, testPassCount: null, filesChanged: [fileWrite] }),
    );
    const current = makeIteration({
      seq: T.testStagnationCriticalIterations - 1,
      testPassCount: null,
      filesChanged: [fileWrite],
    });

    expect(signalDPrime_testStagnationWithWrites(history, current, T)).toBeNull();
  });

  it('uses the latest contiguous measured suffix after an older null count', () => {
    const history = [
      makeIteration({ seq: 0, testPassCount: null, filesChanged: [{ path: 'x', additions: 1, deletions: 0, contentHash: 'h0' }] }),
      makeIteration({ seq: 1, testPassCount: 4, filesChanged: [{ path: 'x', additions: 1, deletions: 0, contentHash: 'h1' }] }),
      makeIteration({ seq: 2, testPassCount: 4, filesChanged: [{ path: 'x', additions: 1, deletions: 0, contentHash: 'h2' }] }),
    ];
    const current = makeIteration({
      seq: 3,
      testPassCount: 4,
      filesChanged: [{ path: 'x', additions: 1, deletions: 0, contentHash: 'h3' }],
    });

    const sig = signalDPrime_testStagnationWithWrites(history, current, T);

    expect(sig?.verdict).toBe('WARN');
    expect(sig?.detail).toMatchObject({ iterations: T.testStagnationWarnIterations, passCount: 4 });
  });

  it('null when test count changes', () => {
    const history = [
      makeIteration({ testPassCount: 1, filesChanged: [{ path: 'x', additions: 1, deletions: 0, contentHash: 'h' }] }),
      makeIteration({ testPassCount: 2, filesChanged: [{ path: 'x', additions: 1, deletions: 0, contentHash: 'h2' }] }),
    ];
    const current = makeIteration({ testPassCount: 3, filesChanged: [{ path: 'x', additions: 1, deletions: 0, contentHash: 'h3' }] });
    expect(signalDPrime_testStagnationWithWrites(history, current, T)).toBeNull();
  });

  it('WARN at warn threshold', () => {
    const history = Array.from({ length: T.testStagnationWarnIterations - 1 }, () =>
      makeIteration({ testPassCount: 4, filesChanged: [{ path: 'x', additions: 1, deletions: 0, contentHash: 'h' }] }),
    );
    const current = makeIteration({ testPassCount: 4, filesChanged: [{ path: 'x', additions: 1, deletions: 0, contentHash: 'h' }] });
    const sig = signalDPrime_testStagnationWithWrites(history, current, T);
    expect(sig?.verdict).toBe('WARN');
  });
});

describe('signal E — error repeat', () => {
  it('CRITICAL on same exact-hash 3-in-a-row', () => {
    const history = [
      makeIteration({ errors: [{ bucket: 'B', exactHash: 'h', excerpt: 'ENOENT foo' }] }),
      makeIteration({ errors: [{ bucket: 'B', exactHash: 'h', excerpt: 'ENOENT foo' }] }),
    ];
    const current = makeIteration({ errors: [{ bucket: 'B', exactHash: 'h', excerpt: 'ENOENT foo' }] });
    const sig = signalE_errorRepeat(history, current, T);
    expect(sig?.verdict).toBe('CRITICAL');
  });

  it('WARN on bucket repeats at warn threshold (3 in window)', () => {
    const history = [
      makeIteration({ errors: [{ bucket: 'B', exactHash: 'h1', excerpt: 'e1' }] }),
      makeIteration({ errors: [{ bucket: 'B', exactHash: 'h2', excerpt: 'e2' }] }),
    ];
    const current = makeIteration({ errors: [{ bucket: 'B', exactHash: 'h3', excerpt: 'e3' }] });
    const sig = signalE_errorRepeat(history, current, T);
    expect(sig?.verdict).toBe('WARN');
  });

  it('CRITICAL on bucket repeats at critical threshold (4 in window)', () => {
    const history = [
      makeIteration({ errors: [{ bucket: 'B', exactHash: 'h1', excerpt: 'e1' }] }),
      makeIteration({ errors: [{ bucket: 'B', exactHash: 'h2', excerpt: 'e2' }] }),
      makeIteration({ errors: [{ bucket: 'B', exactHash: 'h3', excerpt: 'e3' }] }),
    ];
    const current = makeIteration({ errors: [{ bucket: 'B', exactHash: 'h4', excerpt: 'e4' }] });
    const sig = signalE_errorRepeat(history, current, T);
    expect(sig?.verdict).toBe('CRITICAL');
  });
});

describe('signal F — token burn without progress', () => {
  // Signal F is opt-in. The default-config thresholds (T) ship with
  // pauseOnTokenBurn:false, so we explicitly enable it for the cases
  // that exercise the firing paths. Suppression-by-default is a
  // separately-named case so a regression on either branch is obvious.
  const T_ON: typeof T = { ...T, pauseOnTokenBurn: true };

  it('returns null by default (opt-in flag is off)', () => {
    const state = makeState({ tokensSinceLastTestImprovement: T.tokensWithoutProgressCritical });
    expect(signalF_tokenBurn(state, [], makeIteration(), T)).toBeNull();
  });

  it('returns null even on 3-iters-of-10k-tokens when opt-in flag is off', () => {
    const history = [makeIteration({ tokens: 11000 }), makeIteration({ tokens: 12000 })];
    const current = makeIteration({ tokens: 13000 });
    expect(signalF_tokenBurn(makeState(), history, current, T)).toBeNull();
  });

  it('CRITICAL when accumulated tokens >= critical (with opt-in)', () => {
    const state = makeState({ tokensSinceLastTestImprovement: T_ON.tokensWithoutProgressCritical });
    const sig = signalF_tokenBurn(state, [], makeIteration(), T_ON);
    expect(sig?.verdict).toBe('CRITICAL');
  });

  it('CRITICAL when 3 iterations each > 10k tokens (with opt-in)', () => {
    const history = [makeIteration({ tokens: 11000 }), makeIteration({ tokens: 12000 })];
    const current = makeIteration({ tokens: 13000 });
    const sig = signalF_tokenBurn(makeState(), history, current, T_ON);
    expect(sig?.verdict).toBe('CRITICAL');
  });
});

describe('signal G — tool repetition', () => {
  it('WARN at warn threshold within iteration', () => {
    const th = {
      ...T,
      identicalToolCallConsecutiveCritical: T.toolRepeatWarnPerIteration + 1,
    } satisfies LoopProgressThresholds;
    const calls = Array.from({ length: th.toolRepeatWarnPerIteration }, () => ({
      toolName: 'Read', argsHash: 'a', success: true, durationMs: 1,
    }));
    const sig = signalG_toolRepetition([], makeIteration({ toolCalls: calls }), th);
    expect(sig?.verdict).toBe('WARN');
  });

  it('CRITICAL when same set across 3 iterations', () => {
    const set = [
      { toolName: 'Read', argsHash: 'a', success: true, durationMs: 1 },
      { toolName: 'Edit', argsHash: 'b', success: true, durationMs: 1 },
    ];
    const history = [
      makeIteration({ toolCalls: set }),
      makeIteration({ toolCalls: set }),
    ];
    const current = makeIteration({ toolCalls: set });
    const sig = signalG_toolRepetition(history, current, T);
    expect(sig?.verdict).toBe('CRITICAL');
  });

  it('CRITICAL at three consecutive identical tool calls before the generic repeat threshold', () => {
    const th = {
      ...T,
      toolRepeatWarnPerIteration: 5,
      toolRepeatCriticalPerIteration: 8,
      identicalToolCallConsecutiveCritical: 3,
    } satisfies LoopProgressThresholds;
    const current = makeIteration({
      toolCalls: [
        { toolName: 'Read', argsHash: 'same-file', success: true, durationMs: 1 },
        { toolName: 'Read', argsHash: 'same-file', success: true, durationMs: 1 },
        { toolName: 'Read', argsHash: 'same-file', success: true, durationMs: 1 },
      ],
    });

    const sig = signalG_toolRepetition([], current, th);

    expect(sig?.verdict).toBe('CRITICAL');
    expect(sig?.message).toContain('consecutively');
    expect(sig?.detail).toMatchObject({ consecutiveIdentical: 3 });
  });
});

describe('signal I — idempotent read identity', () => {
  it('WARNs when read-only tools return the same result hash 3 times without edits', () => {
    const history = [
      makeIteration({
        seq: 0,
        toolCalls: [{ toolName: 'Read', argsHash: 'src/a.ts', resultHash: 'same-output', success: true, durationMs: 1 }],
        workHash: 'read-0',
      }),
      makeIteration({
        seq: 1,
        toolCalls: [{ toolName: 'Read', argsHash: 'src/./a.ts', resultHash: 'same-output', success: true, durationMs: 1 }],
        workHash: 'read-1',
      }),
    ];
    const current = makeIteration({
      seq: 2,
      toolCalls: [{ toolName: 'Read', argsHash: 'SRC/a.ts', resultHash: 'same-output', success: true, durationMs: 1 }],
      workHash: 'read-2',
    });

    const sig = signalI_idempotentReadIdentity(history, current, T);

    expect(sig?.id).toBe('I');
    expect(sig?.verdict).toBe('WARN');
    expect(sig?.detail).toMatchObject({ repeatCount: 3, resultHash: 'same-output' });
  });

  it('ignores repeated result hashes from write-capable or failed tool calls', () => {
    const history = [
      makeIteration({
        toolCalls: [{ toolName: 'Edit', argsHash: 'src/a.ts', resultHash: 'same-output', success: true, durationMs: 1 }],
      }),
      makeIteration({
        toolCalls: [{ toolName: 'Read', argsHash: 'src/a.ts', resultHash: 'same-output', success: false, durationMs: 1 }],
      }),
    ];
    const current = makeIteration({
      toolCalls: [{ toolName: 'Write', argsHash: 'src/a.ts', resultHash: 'same-output', success: true, durationMs: 1 }],
    });

    expect(signalI_idempotentReadIdentity(history, current, T)).toBeNull();
  });

  it('ignores stale repeated read results outside the recent progress window', () => {
    const history = [
      makeIteration({
        seq: 0,
        toolCalls: [{ toolName: 'Read', argsHash: 'old-0', resultHash: 'same-output', success: true, durationMs: 1 }],
      }),
      makeIteration({ seq: 1, toolCalls: [] }),
      makeIteration({ seq: 2, toolCalls: [] }),
      makeIteration({ seq: 3, toolCalls: [] }),
      makeIteration({
        seq: 4,
        toolCalls: [{ toolName: 'Read', argsHash: 'recent-0', resultHash: 'same-output', success: true, durationMs: 1 }],
      }),
    ];
    const current = makeIteration({
      seq: 5,
      toolCalls: [{ toolName: 'Read', argsHash: 'recent-1', resultHash: 'same-output', success: true, durationMs: 1 }],
    });

    expect(signalI_idempotentReadIdentity(history, current, T)).toBeNull();
  });
});

describe('signal H — output similarity', () => {
  it('CRITICAL when last 3 outputs are highly similar', () => {
    const text = 'I will refactor the verification pipeline to extract a coordinator and a runner so the lifecycle is clearer';
    const history = [makeIteration({ outputExcerpt: text }), makeIteration({ outputExcerpt: text })];
    const current = makeIteration({ outputExcerpt: text });
    const sig = signalH_outputSimilarity(history, current, T);
    expect(sig?.verdict).toBe('CRITICAL');
  });

  it('null when outputs are very different', () => {
    const history = [
      makeIteration({ outputExcerpt: 'aaaa bbbb cccc dddd eeee ffff' }),
      makeIteration({ outputExcerpt: 'gggg hhhh iiii jjjj kkkk llll' }),
    ];
    const current = makeIteration({ outputExcerpt: 'mmmm nnnn oooo pppp qqqq rrrr' });
    expect(signalH_outputSimilarity(history, current, T)).toBeNull();
  });
});

describe('LoopProgressDetector aggregator', () => {
  const det = new LoopProgressDetector();

  it('returns OK when no signals fire', () => {
    const result = det.evaluate(makeState(), [], makeIteration());
    expect(result.verdict).toBe('OK');
    expect(result.signals).toEqual([]);
  });

  it('escalates 3 WARNs in window to CRITICAL', () => {
    const state = makeState({
      currentStage: 'PLAN',
      iterationsOnCurrentStage: T.stageWarnIterations.PLAN, // emit C-WARN
      recentWarnIterationSeqs: [3, 5], // 2 previous WARNs in window
    });
    const current = makeIteration({ seq: 6 });
    const result = det.evaluate(state, [], current);
    // 2 prior warns + this iteration warn = 3 warns; warnEscalationCount default = 3 → CRITICAL
    expect(result.verdict).toBe('CRITICAL');
  });

  it('CRITICAL signal short-circuits to CRITICAL', () => {
    const state = makeState();
    const history = [
      makeIteration({ workHash: 'X' }),
      makeIteration({ workHash: 'X' }),
    ];
    const current = makeIteration({ workHash: 'X' });
    const result = det.evaluate(state, history, current);
    expect(result.verdict).toBe('CRITICAL');
    expect(result.primary?.id).toBe('A');
  });

  it('shouldRefuseToSpawnNext fires on identical-hash CRITICAL', () => {
    const history = [
      makeIteration({ workHash: 'X' }),
      makeIteration({ workHash: 'X' }),
      makeIteration({ workHash: 'X' }),
    ];
    const block = det.shouldRefuseToSpawnNext(makeState(), history);
    expect(block).not.toBeNull();
    expect(block?.id).toBe('A');
  });

  it('treats a confirmed idempotent-read signal as a pre-iteration block', () => {
    const readCall = (seq: number, progressSignals: LoopIteration['progressSignals'] = []) =>
      makeIteration({
        seq,
        workHash: `read-${seq}`,
        toolCalls: [{ toolName: 'Read', argsHash: `variant-${seq}`, resultHash: 'same-output', success: true, durationMs: 1 }],
        progressSignals,
      });
    const history = [
      readCall(0),
      readCall(1),
      readCall(2, [{ id: 'I', verdict: 'WARN', message: 'prior repeated read' }]),
      readCall(3),
    ];

    const block = det.shouldRefuseToSpawnNext(makeState(), history);

    expect(block?.id).toBe('I');
    expect(block?.verdict).toBe('CRITICAL');
  });
});

describe('FU-4: weak-signal confirmation phase', () => {
  const det = new LoopProgressDetector();
  const text = 'I will refactor the verification pipeline to extract a coordinator and a runner so the lifecycle is clearer';
  // Distinct work hashes per iteration so signal A doesn't fire alongside H —
  // we want to isolate the weak-signal downgrade behaviour for H.
  const iter = (seq: number, progressSignals: LoopIteration['progressSignals'] = []) =>
    makeIteration({ seq, outputExcerpt: text, workHash: `h-${seq}`, progressSignals });

  it('downgrades signal H CRITICAL to WARN on first occurrence when no strong signal accompanies it', () => {
    const history = [iter(0), iter(1)];
    const current = iter(2);
    const result = det.evaluate(makeState(), history, current);
    expect(result.verdict).toBe('WARN');
    const h = result.signals.find((s) => s.id === 'H');
    expect(h?.verdict).toBe('WARN');
    expect(h?.message).toContain('provisional');
  });

  it('keeps signal H CRITICAL when the previous iteration also recorded an H signal (confirmed)', () => {
    const history = [
      iter(0),
      iter(1, [{ id: 'H', verdict: 'WARN', message: 'prior H' }]),
    ];
    const current = iter(2);
    const result = det.evaluate(makeState(), history, current);
    expect(result.verdict).toBe('CRITICAL');
    const h = result.signals.find((s) => s.id === 'H');
    expect(h?.verdict).toBe('CRITICAL');
    expect(h?.message).not.toContain('provisional');
  });

  it('keeps signal H CRITICAL when a strong signal also fires this iteration', () => {
    // Same hash across iterations triggers signal A as the strong signal.
    const history = [
      makeIteration({ outputExcerpt: text, workHash: 'X', progressSignals: [] }),
      makeIteration({ outputExcerpt: text, workHash: 'X', progressSignals: [] }),
    ];
    const current = makeIteration({ outputExcerpt: text, workHash: 'X' });
    const result = det.evaluate(makeState(), history, current);
    expect(result.verdict).toBe('CRITICAL');
    const h = result.signals.find((s) => s.id === 'H');
    expect(h?.verdict).toBe('CRITICAL');
  });

  it('shouldRefuseToSpawnNext does not block when H is unconfirmed', () => {
    const history = [iter(0), iter(1), iter(2)];
    const block = det.shouldRefuseToSpawnNext(makeState(), history);
    expect(block).toBeNull();
  });

  it('shouldRefuseToSpawnNext blocks when H was recorded in the prior iteration too', () => {
    const history = [
      iter(0),
      iter(1, [{ id: 'H', verdict: 'WARN', message: 'prior' }]),
      iter(2, [{ id: 'H', verdict: 'WARN', message: 'prior' }]),
    ];
    const block = det.shouldRefuseToSpawnNext(makeState(), history);
    expect(block?.id).toBe('H');
  });
});
