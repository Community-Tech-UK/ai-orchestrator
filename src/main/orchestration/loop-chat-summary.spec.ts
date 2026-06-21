import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOOP_MAX_ITERATIONS,
  DEFAULT_LOOP_MAX_WALL_TIME_MS,
  defaultLoopConfig,
  type LoopState,
} from '../../shared/types/loop.types';
import {
  buildLoopContextHandoff,
  buildLoopInterveneChatEvent,
  buildLoopStartChatEvent,
  buildLoopTerminalChatSummary,
} from './loop-chat-summary';

describe('buildLoopStartChatEvent', () => {
  it('emits the user prompt verbatim as a user-role event so it renders as a user bubble', () => {
    const state = makeState({
      id: 'loop-7',
      chatId: 'chat-9',
      status: 'running',
      startedAt: 10_000,
      endedAt: null,
      config: defaultLoopConfig('/work/project', 'Ship the dark mode fix'),
    });

    const event = buildLoopStartChatEvent(state);

    expect(event).toEqual({
      chatId: 'chat-9',
      nativeMessageId: 'loop-start:loop-7',
      nativeTurnId: 'loop:loop-7',
      phase: 'loop_start',
      role: 'user',
      content: 'Ship the dark mode fix',
      createdAt: 10_000,
      metadata: expect.objectContaining({
        kind: 'loop-start',
        loopRunId: 'loop-7',
        workspaceCwd: '/work/project',
        provider: 'claude',
        reviewStyle: 'debate',
        iterationCap: DEFAULT_LOOP_MAX_ITERATIONS,
        maxWallTimeMs: DEFAULT_LOOP_MAX_WALL_TIME_MS,
      }),
    });
  });

  it('uses a different nativeMessageId than the terminal summary so both can coexist in the same turn', () => {
    const state = makeState({ id: 'loop-shared', status: 'running', endedAt: null });

    const start = buildLoopStartChatEvent(state);
    const end = buildLoopTerminalChatSummary({ ...state, status: 'completed', endedAt: 99_000 });

    expect(start.nativeMessageId).not.toBe(end.nativeMessageId);
    expect(start.nativeTurnId).toBe(end.nativeTurnId);
  });

  it('passes the prompt through unmodified — long prompts collapse in the renderer, not at the ledger', () => {
    const longPrompt = 'x'.repeat(5_000);
    const state = makeState({
      config: defaultLoopConfig('/work/project', longPrompt),
    });

    const event = buildLoopStartChatEvent(state);

    expect(event.content).toBe(longPrompt);
  });
});

describe('buildLoopInterveneChatEvent', () => {
  it('emits the user nudge as a user-role event scoped to the loop turn', () => {
    const state = makeState({
      id: 'loop-9',
      chatId: 'chat-3',
      status: 'running',
      endedAt: null,
    });

    const event = buildLoopInterveneChatEvent({
      state,
      interventionId: 'abc-123',
      message: 'try a different approach',
      createdAt: 50_000,
    });

    expect(event).toEqual({
      chatId: 'chat-3',
      nativeMessageId: 'loop-intervene:loop-9:abc-123',
      nativeTurnId: 'loop:loop-9',
      phase: 'loop_intervene',
      role: 'user',
      content: 'try a different approach',
      createdAt: 50_000,
      metadata: {
        kind: 'loop-intervene',
        loopRunId: 'loop-9',
        interventionId: 'abc-123',
      },
    });
  });
});

describe('buildLoopTerminalChatSummary', () => {
  it('formats a durable terminal summary with goal, status, workspace, and latest evidence', () => {
    const state = makeState({
      status: 'completed',
      endReason: 'signal=done-promise',
      totalIterations: 2,
      totalTokens: 12_345,
      totalCostCents: 19,
      lastIteration: {
        id: 'iter-1',
        loopRunId: 'loop-1',
        seq: 1,
        stage: 'IMPLEMENT',
        startedAt: 1_000,
        endedAt: 2_000,
        childInstanceId: 'child-1',
        tokens: 1_000,
        costCents: 2,
        filesChanged: [
          { path: 'src/a.ts', additions: 10, deletions: 1, contentHash: 'a' },
          { path: 'src/b.ts', additions: 3, deletions: 0, contentHash: 'b' },
        ],
        toolCalls: [],
        errors: [],
        testPassCount: 12,
        testFailCount: 0,
        workHash: 'hash',
        outputSimilarityToPrev: null,
        outputExcerpt: 'Implemented the final loop slice.',
        outputFull: 'Implemented the final loop slice.',
        progressVerdict: 'OK',
        progressSignals: [],
        completionSignalsFired: [{ id: 'done-promise', sufficient: true, detail: 'done' }],
        verifyStatus: 'passed',
        verifyOutputExcerpt: 'all checks passed',
      },
    });

    const summary = buildLoopTerminalChatSummary(state);

    expect(summary).toEqual({
      chatId: 'chat-1',
      nativeMessageId: 'loop-summary:loop-1',
      nativeTurnId: 'loop:loop-1',
      phase: 'loop_summary',
      createdAt: 65_000,
      content: expect.stringContaining('Loop ended - completed'),
      metadata: expect.objectContaining({
        kind: 'loop-summary',
        loopRunId: 'loop-1',
        status: 'completed',
        workspaceCwd: '/work/project',
      }),
    });
    expect(summary.content).not.toContain('Goal:');
    expect(summary.content).toContain('Workspace: /work/project');
    expect(summary.content).toContain('Iterations: 2');
    expect(summary.content).toContain('Tokens: 12,345');
    expect(summary.content).toContain('Cost: $0.19');
    expect(summary.content).toContain('Files changed: 2');
    expect(summary.content).toContain('src/a.ts');
    expect(summary.content).toContain('Verify: passed');
    expect(summary.content).toContain('all checks passed');
  });

  it('renders the full closing message (not the tiny detection excerpt) in the latest evidence', () => {
    // A realistic closing message that comfortably exceeds the old 2 KB chat
    // cap but fits the display bound — it must appear whole.
    const closing = `Summary of work:\n${'Finding line that explains the change. '.repeat(120)}`;
    expect(closing.length).toBeGreaterThan(2_000);
    expect(closing.length).toBeLessThan(16_000);

    const state = makeState({
      status: 'completed',
      lastIteration: makeLastIteration({
        outputExcerpt: closing.slice(0, 100),
        outputFull: closing,
        verifyStatus: 'not-run',
        verifyOutputExcerpt: '',
      }),
    });

    const summary = buildLoopTerminalChatSummary(state);
    expect(summary.content).toContain('Latest evidence:');
    expect(summary.content).toContain(closing.trim());
    expect(summary.content).not.toContain('(truncated');
  });

  it('truncates an oversized closing message with a pointer to the full surfaces', () => {
    const huge = 'q'.repeat(20_000);
    const state = makeState({
      status: 'completed',
      lastIteration: makeLastIteration({
        outputExcerpt: 'q'.repeat(100),
        outputFull: huge,
        verifyStatus: 'not-run',
        verifyOutputExcerpt: '',
      }),
    });

    const summary = buildLoopTerminalChatSummary(state);
    expect(summary.content).toContain('(truncated');
    expect(summary.content).toContain('Loop trace');
    // Bounded, not the full 20 KB.
    expect(summary.content.length).toBeLessThan(huge.length);
  });
});

describe('buildLoopContextHandoff', () => {
  it('frames the loop as background work and carries objective, outcome, files, and final response so the next turn can answer follow-ups', () => {
    const state = makeState({
      status: 'completed',
      endReason: 'ping-pong converged: reviewer APPROVED',
      totalIterations: 4,
      config: defaultLoopConfig('/work/project', 'Review the worktree isolation plan'),
      lastIteration: {
        id: 'iter-3',
        loopRunId: 'loop-1',
        seq: 3,
        stage: 'IMPLEMENT',
        startedAt: 1_000,
        endedAt: 2_000,
        childInstanceId: 'child-1',
        tokens: 1_000,
        costCents: 2,
        filesChanged: [{ path: 'src/a.ts', additions: 10, deletions: 1, contentHash: 'a' }],
        toolCalls: [],
        errors: [],
        testPassCount: 12,
        testFailCount: 0,
        workHash: 'hash',
        outputSimilarityToPrev: null,
        outputExcerpt: 'All three reviewer findings were valid and addressed.',
        outputFull: 'All three reviewer findings were valid and addressed.',
        progressVerdict: 'OK',
        progressSignals: [],
        completionSignalsFired: [],
        verifyStatus: 'passed',
        verifyOutputExcerpt: '',
      },
    });

    const handoff = buildLoopContextHandoff(state);

    expect(handoff).toContain('background');
    expect(handoff).toContain('Objective: Review the worktree isolation plan');
    expect(handoff).toContain('Outcome: completed - ping-pong converged: reviewer APPROVED');
    expect(handoff).toContain('Iterations: 4');
    expect(handoff).toContain('Files changed: 1');
    expect(handoff).toContain('src/a.ts');
    expect(handoff).toContain('All three reviewer findings were valid and addressed.');
  });

  it('degrades gracefully when no iteration ran (objective + outcome only, no crash)', () => {
    const state = makeState({
      status: 'cancelled',
      endReason: 'user-cancelled',
      totalIterations: 0,
      lastIteration: undefined,
    });

    const handoff = buildLoopContextHandoff(state);

    expect(handoff).toContain('Outcome: cancelled - user-cancelled');
    expect(handoff).toContain('Iterations: 0');
    expect(handoff).not.toContain('Files changed:');
    expect(handoff).not.toContain('final response');
  });

  it('truncates a pathological final response so the handoff stays bounded', () => {
    const huge = 'y'.repeat(20_000);
    const state = makeState({
      lastIteration: {
        id: 'iter-1',
        loopRunId: 'loop-1',
        seq: 1,
        stage: 'IMPLEMENT',
        startedAt: 1_000,
        endedAt: 2_000,
        childInstanceId: null,
        tokens: 0,
        costCents: 0,
        filesChanged: [],
        toolCalls: [],
        errors: [],
        testPassCount: null,
        testFailCount: null,
        workHash: 'hash',
        outputSimilarityToPrev: null,
        outputExcerpt: '',
        outputFull: huge,
        progressVerdict: 'OK',
        progressSignals: [],
        completionSignalsFired: [],
        verifyStatus: 'not-run',
        verifyOutputExcerpt: '',
      },
    });

    const handoff = buildLoopContextHandoff(state);

    expect(handoff.length).toBeLessThan(12_000);
    expect(handoff).toContain('truncated');
  });
});

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    config: defaultLoopConfig('/work/project', 'Build the thing.'),
    status: 'completed',
    startedAt: 0,
    endedAt: 65_000,
    totalIterations: 1,
    totalTokens: 0,
    totalCostCents: 0,
    currentStage: 'IMPLEMENT',
    endReason: 'completed',
    pendingInterventions: [],
    completedFileRenameObserved: false,
    doneSentinelPresentAtStart: false,
    planChecklistFullyCheckedAtStart: false,
    uncompletedPlanFilesAtStart: [],
    tokensSinceLastTestImprovement: 0,
    highestTestPassCount: 0,
    iterationsOnCurrentStage: 0,
    recentWarnIterationSeqs: [],
    ...overrides,
  };
}

function makeLastIteration(
  overrides: Partial<NonNullable<LoopState['lastIteration']>> = {},
): NonNullable<LoopState['lastIteration']> {
  return {
    id: 'iter-1',
    loopRunId: 'loop-1',
    seq: 1,
    stage: 'IMPLEMENT',
    startedAt: 1_000,
    endedAt: 2_000,
    childInstanceId: 'child-1',
    tokens: 1_000,
    costCents: 2,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    workHash: 'hash',
    outputSimilarityToPrev: null,
    outputExcerpt: '',
    outputFull: '',
    progressVerdict: 'OK',
    progressSignals: [],
    completionSignalsFired: [],
    verifyStatus: 'not-run',
    verifyOutputExcerpt: '',
    ...overrides,
  };
}
