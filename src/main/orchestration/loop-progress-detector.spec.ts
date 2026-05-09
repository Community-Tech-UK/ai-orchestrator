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
    tokensSinceLastTestImprovement: 0,
    highestTestPassCount: 0,
    iterationsOnCurrentStage: 0,
    recentWarnIterationSeqs: [],
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
  it('CRITICAL when accumulated tokens >= critical', () => {
    const state = makeState({ tokensSinceLastTestImprovement: T.tokensWithoutProgressCritical });
    const sig = signalF_tokenBurn(state, [], makeIteration(), T);
    expect(sig?.verdict).toBe('CRITICAL');
  });

  it('CRITICAL when 3 iterations each > 10k tokens', () => {
    const history = [makeIteration({ tokens: 11000 }), makeIteration({ tokens: 12000 })];
    const current = makeIteration({ tokens: 13000 });
    const sig = signalF_tokenBurn(makeState(), history, current, T);
    expect(sig?.verdict).toBe('CRITICAL');
  });
});

describe('signal G — tool repetition', () => {
  it('WARN at warn threshold within iteration', () => {
    const calls = Array.from({ length: T.toolRepeatWarnPerIteration }, () => ({
      toolName: 'Read', argsHash: 'a', success: true, durationMs: 1,
    }));
    const sig = signalG_toolRepetition([], makeIteration({ toolCalls: calls }), T);
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
});
