/**
 * A worker is told "the ticket changed since you started" only when James approved new text after the job began: the first
 * check that found no change is the claim, and his answer is later. A ticket never claimed, or changed before the claim,
 * says nothing of the kind.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _setPlanQueueDataDirForTesting } from './plan-queue-data-dir';
import type { PlanQueueLinearTicketRecord } from './plan-queue-linear-ticket-store';
import { ticketPromptContext } from './plan-queue-ticket-round';
import { newPlanQueueItem } from './plan-queue-state';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'ticket-round-changed-')); _setPlanQueueDataDirForTesting(dataDir); });
afterEach(() => { _setPlanQueueDataDirForTesting(null); rmSync(dataDir, { recursive: true, force: true }); });

const record = (over: Partial<PlanQueueLinearTicketRecord>): PlanQueueLinearTicketRecord => ({
  itemId: 'item-1', linearId: 'lin-1', identifier: 'ORC-1', address: 'https://linear.app/x/issue/ORC-1', teamId: 't', projectId: 'p',
  approvedTitle: 'Title', approvedText: { description: 'Text', comments: [], labels: [], priority: 0, projectName: null, relatedTickets: [], attachmentNames: [] },
  approvedHash: 'a'.repeat(64), approvedAt: 100, claimedAt: null, openAsk: null, leftOutHash: null, textClearedAt: null, ...over,
});

async function changedSinceStart(over: Partial<PlanQueueLinearTicketRecord>): Promise<boolean | undefined> {
  const context = await ticketPromptContext({ record: () => record(over) }, { item: newPlanQueueItem('item-1', 'run-1', 'linear:lin-1', 1), repoRoot: '/an/unrelated/repository', worktreePath: null });
  return context.changedSinceStart;
}

describe('whether the prompt says the ticket changed since the worker started', () => {
  it('says so when the text was approved after the claim', async () => {
    expect(await changedSinceStart({ claimedAt: 200, approvedAt: 300 })).toBe(true);
  });
  it('says nothing for text approved before the claim, at the same moment as it, or never claimed', async () => {
    expect(await changedSinceStart({ claimedAt: 300, approvedAt: 100 })).toBe(false);
    expect(await changedSinceStart({ claimedAt: 300, approvedAt: 300 })).toBe(false);
    expect(await changedSinceStart({ claimedAt: null, approvedAt: 300 })).toBe(false);
  });
});
