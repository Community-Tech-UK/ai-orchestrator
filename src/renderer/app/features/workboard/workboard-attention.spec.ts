import { describe, expect, it } from 'vitest';
import type { LoopRunSummaryPayload } from '@contracts/schemas/loop';
import { projectWorkboard } from './workboard-projection';
import type { WorkboardProjectionInput } from './workboard.types';

const now = Date.now();
const paused: LoopRunSummaryPayload = {
  id: 'l', chatId: 'a', status: 'paused', workspaceCwd: '/work', initialPrompt: 'Build', iterationPrompt: null,
  totalIterations: 1, totalTokens: 0, totalCostCents: 0, startedAt: now, endedAt: null, endReason: null,
};
const input = (): WorkboardProjectionInput => ({ instances: [], loopRuns: [paused], automationRuns: [], automations: [], repoJobs: [], now });

describe('Needs-you projection policy', () => {
  it.each([
    ['sign-off', 'Needs your sign-off'], ['blocked', 'Blocked: the agent asked for help'],
    ['step-failed', 'Paused: a step failed'], ['stuck', 'Stuck: needs your decision'],
  ] as const)('promotes only a live %s pause', (reason, statusLabel) => {
    expect(projectWorkboard({ ...input(), pausedForYou: new Map([['l', reason]]) })[0])
      .toMatchObject({ lane: 'needs-you', attentionLevel: 'blocked', statusLabel });
  });
  it('keeps stranded or manually paused loops in Waiting', () => {
    expect(projectWorkboard(input())[0]).toMatchObject({ lane: 'waiting', attentionLevel: 'waiting' });
  });
  it('promotes pending approvals even when the provider has not updated session status yet', () => {
    const result = projectWorkboard({ ...input(), loopRuns: [], instances: [{ id: 'a', status: 'busy', displayName: 'Fix login', provider: 'claude', workingDirectory: '/work', lastActivity: now, pendingApprovalCount: 1 }] });
    expect(result[0]).toMatchObject({ lane: 'needs-you', attentionLevel: 'blocked' });
  });
});
