import { describe, expect, it } from 'vitest';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import {
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
        iterationCap: 50,
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
