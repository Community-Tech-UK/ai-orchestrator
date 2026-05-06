import { describe, expect, it } from 'vitest';
import type { OperatorRunGraph } from '../../shared/types/operator.types';
import { synthesizeOperatorRun } from './operator-synthesis-executor';

describe('synthesizeOperatorRun', () => {
  it('includes project-agent changed files in completed work', () => {
    const synthesis = synthesizeOperatorRun(makeGraph({
      projectAgent: {
        outputPreview: 'Implemented voice conversations.',
        changedFiles: [
          '/work/ai-orchestrator/src/main/voice.ts',
          '/work/ai-orchestrator/src/renderer/voice.component.ts',
        ],
      },
    }, null));

    expect(synthesis.completedWork).toEqual(expect.arrayContaining([
      'Implemented voice conversations.',
      'Changed files: /work/ai-orchestrator/src/main/voice.ts, /work/ai-orchestrator/src/renderer/voice.component.ts',
    ]));
  });

  it('classifies failed repo jobs as failed work', () => {
    const synthesis = synthesizeOperatorRun(makeGraph({
      repoJob: {
        status: 'failed',
        error: 'Audit worker failed',
      },
    }, 'Repo job failed'));

    expect(synthesis.completedWork).not.toContain('Repository job finished with status failed');
    expect(synthesis.failedWork).toEqual(expect.arrayContaining([
      'Repository job finished with status failed',
      'Repo job failed',
    ]));
  });
});

function makeGraph(resultJson: Record<string, unknown>, error: string | null): OperatorRunGraph {
  return {
    run: {
      id: 'run-1',
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      title: 'Audit Dingley',
      status: error ? 'failed' : 'completed',
      autonomyMode: 'full',
      createdAt: 1,
      updatedAt: 1,
      completedAt: 2,
      goal: 'Audit the dingley project',
      budget: {
        maxNodes: 50,
        maxRetries: 3,
        maxWallClockMs: 1000,
        maxConcurrentNodes: 3,
      },
      usageJson: {
        nodesStarted: 1,
        nodesCompleted: 1,
        retriesUsed: 0,
        wallClockMs: 1,
      },
      planJson: {},
      resultJson,
      error,
    },
    nodes: [],
    events: [],
  };
}
