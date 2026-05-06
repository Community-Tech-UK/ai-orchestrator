import { describe, expect, it } from 'vitest';
import type { Automation, CreateAutomationInput } from '../../shared/types/automation.types';
import type {
  OperatorProjectRecord,
  OperatorRunGraph,
} from '../../shared/types/operator.types';
import {
  OperatorFollowUpScheduler,
  parseOperatorFollowUpSchedule,
} from './operator-follow-up-scheduler';

describe('OperatorFollowUpScheduler', () => {
  it('parses common deferred and recurring follow-up schedules', () => {
    expect(parseOperatorFollowUpSchedule('check back in 2 hours', {
      now: 1_000,
      timezone: 'UTC',
    })).toEqual({
      type: 'oneTime',
      runAt: 7_201_000,
      timezone: 'UTC',
    });
    expect(parseOperatorFollowUpSchedule('check back daily', {
      now: 1_000,
      timezone: 'UTC',
    })).toEqual({
      type: 'cron',
      expression: '0 9 * * *',
      timezone: 'UTC',
    });
    expect(parseOperatorFollowUpSchedule('follow up every 15 minutes', {
      now: 1_000,
      timezone: 'UTC',
    })).toEqual({
      type: 'cron',
      expression: '*/15 * * * *',
      timezone: 'UTC',
    });
    const tomorrowInNewYork = parseOperatorFollowUpSchedule('check back tomorrow', {
      now: Date.UTC(2026, 0, 1, 12, 0, 0),
      timezone: 'America/New_York',
    });
    expect(tomorrowInNewYork).toMatchObject({
      type: 'oneTime',
      timezone: 'America/New_York',
    });
    expect(zonedParts(tomorrowInNewYork?.type === 'oneTime' ? tomorrowInNewYork.runAt : 0, 'America/New_York'))
      .toMatchObject({
        day: 2,
        hour: 9,
        minute: 0,
      });
  });

  it('creates a native automation with project context when a concrete schedule exists', async () => {
    const createdInputs: CreateAutomationInput[] = [];
    const scheduler = new OperatorFollowUpScheduler({
      timezone: 'UTC',
      now: () => 1_000,
      createAutomation: async (input) => {
        createdInputs.push(input);
        return {
          id: 'automation-1',
          active: true,
          createdAt: 1,
          updatedAt: 1,
          nextFireAt: 2,
          lastFiredAt: null,
          lastRunId: null,
          unreadRunCount: 0,
          ...input,
          enabled: input.enabled !== false,
          missedRunPolicy: input.missedRunPolicy ?? 'notify',
          concurrencyPolicy: input.concurrencyPolicy ?? 'skip',
        } satisfies Automation;
      },
    });

    const result = await scheduler.schedule({
      graph: completedGraph('In AI Orchestrator, add voice support and check back daily'),
      projects: [projectRecord()],
    });

    expect(result).toMatchObject({
      status: 'created',
      automationId: 'automation-1',
      schedule: {
        type: 'cron',
        expression: '0 9 * * *',
        timezone: 'UTC',
      },
    });
    expect(createdInputs).toEqual([
      expect.objectContaining({
        name: 'Operator follow-up: Implement voice',
        missedRunPolicy: 'notify',
        concurrencyPolicy: 'skip',
        action: expect.objectContaining({
          workingDirectory: '/work/ai-orchestrator',
          provider: 'auto',
          prompt: expect.stringContaining('Original goal: In AI Orchestrator, add voice support'),
        }),
      }),
    ]);
  });

  it('skips automation creation when follow-up wording has no concrete schedule', async () => {
    const scheduler = new OperatorFollowUpScheduler({
      createAutomation: async () => {
        throw new Error('should not create automation');
      },
    });

    await expect(scheduler.schedule({
      graph: completedGraph('Follow up on this later'),
      projects: [projectRecord()],
    })).resolves.toEqual({
      status: 'skipped',
      reason: 'no-explicit-schedule',
    });
  });
});

function completedGraph(goal: string): OperatorRunGraph {
  return {
    run: {
      id: 'run-1',
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      title: 'Implement voice',
      status: 'completed',
      autonomyMode: 'full',
      createdAt: 1,
      updatedAt: 2,
      completedAt: 3,
      goal,
      budget: {
        maxNodes: 50,
        maxRetries: 3,
        maxWallClockMs: 1_000,
        maxConcurrentNodes: 1,
      },
      usageJson: {
        nodesStarted: 3,
        nodesCompleted: 3,
        retriesUsed: 0,
        wallClockMs: 100,
      },
      planJson: {
        intent: 'project_feature',
      },
      resultJson: {
        synthesis: {
          status: 'completed',
          summaryMarkdown: 'Completed:\n- Implemented voice conversations',
          completedWork: ['Implemented voice conversations'],
          skippedWork: [],
          failedWork: [],
          verification: null,
        },
      },
      error: null,
    },
    nodes: [],
    events: [],
  };
}

function projectRecord(): OperatorProjectRecord {
  return {
    id: 'project-1',
    canonicalPath: '/work/ai-orchestrator',
    displayName: 'AI Orchestrator',
    aliases: ['AI Orchestrator'],
    source: 'scan',
    gitRoot: '/work/ai-orchestrator',
    remotes: [],
    currentBranch: 'main',
    isPinned: false,
    lastSeenAt: 1,
    lastAccessedAt: 1,
    metadata: {},
  };
}

function zonedParts(timestamp: number, timezone: string): {
  day: number;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
  };
}
