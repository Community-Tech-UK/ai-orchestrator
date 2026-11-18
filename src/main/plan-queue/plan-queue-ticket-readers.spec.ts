/**
 * Every reader of an item's work goes through the work-source port, so a ticket (whose reference is not a file) is
 * answered from the ticket table. Two kinds of test: the Linear source answers each new port method from the table and
 * nothing else, and a guard that the callers do not open a document themselves.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({}) }) }));
vi.mock('../orchestration/loop-store', () => ({ getLoopStoreService: () => ({ getDb: () => null }) }));

import { createLinearWorkSource } from './plan-queue-linear-source';
import type { PlanQueueLinearTicketRecord } from './plan-queue-linear-ticket-store';
import { fullTicketText } from './plan-queue-ticket-fixtures.test-helpers';
import { markdownWorkSource } from './plan-queue-markdown-source';
import type { PlanQueueItem } from './plan-queue.types';

const HASH = 'a'.repeat(64);

function record(over: Partial<PlanQueueLinearTicketRecord> = {}): PlanQueueLinearTicketRecord {
  return {
    itemId: 'item-1', linearId: 'lin-12', identifier: 'ORC-12', address: 'https://linear.app/x/issue/ORC-12', teamId: 'team', projectId: 'project',
    approvedTitle: 'Make the sign-in button work', approvedText: fullTicketText(), approvedHash: HASH, approvedAt: 1, claimedAt: null,
    openAsk: null, leftOutHash: null, textClearedAt: null, ...over,
  };
}

function sourceOver(rows: Record<string, PlanQueueLinearTicketRecord | undefined>) {
  return createLinearWorkSource({
    discover: async () => ({ rows: [], labelNote: null }),
    connectionReason: () => null,
    namesFor: () => ({ identifier: 'ORC-12', approvedTitle: 'Make the sign-in button work' }),
    ticketRound: { record: (itemId) => rows[itemId] },
  });
}

const item = { id: 'item-1', sourceRef: 'linear:lin-12', sourceKind: 'linear' as const } as PlanQueueItem;

describe('the Linear source answers the round questions from the ticket table', () => {
  it('reviews the approved hash, which is what a PASS is bound to', async () => {
    await expect(sourceOver({ 'item-1': record() }).reviewFingerprint(item)).resolves.toEqual({ version: 1, documentSha256: HASH, linkedSpecSha256: [] });
  });

  it('has a null fingerprint for a ticket with no row, so a PASS cannot stand', async () => {
    await expect(sourceOver({}).reviewFingerprint(item)).resolves.toMatchObject({ documentSha256: null });
  });

  it('uses the approved hash as the content hash for the progress check, and null when the text is gone', async () => {
    await expect(sourceOver({ 'item-1': record() }).contentHash(item)).resolves.toBe(HASH);
    await expect(sourceOver({ 'item-1': record({ approvedText: null }) }).contentHash(item)).resolves.toBeNull();
  });

  it('pins the approved hash with no checklist items, and gives no pin once the text is gone', async () => {
    await expect(sourceOver({ 'item-1': record() }).readPin(item, 55)).resolves.toMatchObject({ itemId: 'item-1', documentSha256: HASH, unchecked: [], recordedAt: 55 });
    await expect(sourceOver({ 'item-1': record({ approvedText: null }) }).readPin(item, 55)).resolves.toBeNull();
    await expect(sourceOver({}).readPin(item, 55)).resolves.toBeNull();
  });

  it('is large only when its brief is over 100,000 characters', () => {
    expect(sourceOver({ 'item-1': record() }).isLarge(item)).toBe(false);
    const big = record({ approvedText: fullTicketText({ description: 'x'.repeat(100_001) }) });
    expect(sourceOver({ 'item-1': big }).isLarge(item)).toBe(true);
    expect(sourceOver({}).isLarge(item)).toBe(false);
  });

  it('names its row with the identifier and the approved title, and its Set aside entry with the identifier alone', async () => {
    const source = sourceOver({ 'item-1': record() });
    expect(source.rowTitle(item)).toBe('ORC-12 Make the sign-in button work');
    await expect(source.setAsideView(item, '/work/project')).resolves.toEqual({ document: 'ORC-12', documentState: 'open' });
  });

  it('has no step to check, no plan to mark and nothing to trim at a checkpoint', async () => {
    const source = sourceOver({});
    await expect(source.landingProblem(item)).resolves.toBeNull();
    await expect(source.noteOpenLanding(item, { kind: 'tickets' } as never, () => [])).resolves.toEqual([]);
    await expect(source.trimAtCheckpoint(item)).resolves.toBeUndefined();
  });

  it('asks a step-up worker about the ticket, not a document', () => {
    expect(sourceOver({}).stepUpInstruction(2, [])).toContain("make the ticket's work complete and correct");
    expect(markdownWorkSource.stepUpInstruction(2, [])).toContain("make the document's work complete and correct");
  });

  it('refuses to build a prompt when the approved text is gone, in fixed words, and writes nothing', async () => {
    const source = sourceOver({ 'item-1': record({ approvedText: null }) });
    const base = { item, kind: 'tickets' as const, repoRoot: '/work/project', worktreePath: '/work/wt', lastStepOfRun: false };
    await expect(source.workerPrompts.first(base)).rejects.toThrow("This ticket's approved text is not available, so no session can be told about it.");
  });

  it('answers a markdown row with no title, so the page names it from the path', () => {
    expect(markdownWorkSource.rowTitle({ sourceRef: '/repo/docs/a_plan.md', sourceKind: 'markdown' })).toBeNull();
  });
});

describe('no caller opens an item\'s work as a file itself', () => {
  const root = join(__dirname);
  /** What only a source's own file may use: each reads `item.sourceRef` as a document. */
  const DOCUMENT_READERS = [
    'readDocumentReview', 'assertDocumentReview', 'readPlanPin', 'readPlanBrief', 'stepPlanProblem', 'updatePlanIntegrationStatus',
    'isLargeQueueDocument', 'dietAtCheckpoint', 'buildWorkerPrompt', 'buildResumePrompt', 'buildStepUpPrompt', 'buildStepUpInstruction',
    'buildFixPrompt', 'buildVerifierPrompt',
  ];
  const CALLERS = [
    'plan-queue-verification.ts', 'plan-queue-check-groups.ts', 'plan-queue-restart-progress.ts', 'plan-queue-worker-sessions.ts',
    'plan-queue-item-flow.ts', 'plan-queue-step-up.ts', 'plan-queue-item-landing.ts', 'plan-queue-set-aside.ts',
    'plan-queue-checker-spawn.ts', 'plan-queue-run-hold.ts', 'plan-queue-worktree.ts', 'plan-queue-messages.ts',
    'plan-queue-triage.ts',
  ];

  it.each(CALLERS)('%s names none of the document readers', (file) => {
    const text = readFileSync(join(root, file), 'utf8');
    for (const reader of DOCUMENT_READERS) expect(text, `${file} uses ${reader}`).not.toMatch(new RegExp(`\\b${reader}\\b`));
  });

  it('the progress check asks the source for the content hash', () => {
    const text = readFileSync(join(root, 'plan-queue-progress.ts'), 'utf8');
    expect(text).toContain('workSourceFor(item.sourceKind).contentHash(item)');
    expect(text).not.toContain('await documentContentSha256(item.sourceRef)');
  });
});
