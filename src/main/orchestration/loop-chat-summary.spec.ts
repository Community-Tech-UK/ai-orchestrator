import { describe, expect, it } from 'vitest';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import { buildLoopTerminalChatSummary } from './loop-chat-summary';

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
    expect(summary.content).toContain('Goal:\nBuild the thing.');
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
    tokensSinceLastTestImprovement: 0,
    highestTestPassCount: 0,
    iterationsOnCurrentStage: 0,
    recentWarnIterationSeqs: [],
    ...overrides,
  };
}
