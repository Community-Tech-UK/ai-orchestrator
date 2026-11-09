import { mkdirSync, mkdtempSync, promises as realFs, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, PlanQueueItemDtoSchema, PlanQueueQuestionSchema, type PlanQueueQuestion } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import type * as Readiness from './plan-queue-readiness';
import { assertItemTransition, newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

const originalLstat = realFs.lstat;
let workspace: string;
let driver: SqliteDriver;
let store: PlanQueueStore;
let run: PlanQueueRun;
let host: Parameters<typeof reconcileWaitingDocuments>[0];
let applyTriageRecords: typeof Readiness.applyTriageRecords;
let automaticDecisionPatch: typeof Readiness.automaticDecisionPatch;
let missingDocumentNote: typeof Readiness.missingDocumentNote;
let reconcileWaitingDocuments: typeof Readiness.reconcileWaitingDocuments;

function technicalQuestion(): PlanQueueQuestion {
  return {
    question: 'Which verification runner should the worker use?',
    options: [{ id: 'quiet', label: 'Use the documented quiet runner' }, { id: 'skip', label: 'Leave the document alone' }],
    decision: { kind: 'technical', recommendedOptionId: 'quiet', reason: 'Follow project conventions.', evidence: 'AGENTS.md requires npm run test:quiet.' },
  };
}

function addItem(patch: Partial<PlanQueueItem> = {}): PlanQueueItem {
  const item = newPlanQueueItem('item-1', run.id, path.join(workspace, 'a_plan.md'), 1, patch);
  store.upsertItem(item);
  return item;
}

beforeEach(async () => {
  workspace = mkdtempSync(path.join(tmpdir(), 'plan-queue-readiness-'));
  driver = new Database(':memory:') as unknown as SqliteDriver;
  runLoopMigrations(driver);
  store = new PlanQueueStore(driver);
  run = {
    id: 'run-1', parentInstanceId: 'parent-1', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: workspace,
    status: 'running', config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null,
    workerProvider: null, workerModel: null, startedAt: 1, endedAt: null,
  };
  store.upsertRun(run);
  host = {
    store,
    getRun: (id) => store.getRun(id)!,
    getItem: (id) => store.getItem(id)!,
    transition: vi.fn((item, state, patch = {}) => {
      assertItemTransition(item.state, state);
      store.upsertItem({ ...item, ...patch, state });
      return store.getItem(item.id)!;
    }),
    notifyParent: vi.fn(),
  };
  vi.spyOn(realFs, 'lstat');
  syncBuiltinESMExports();
  vi.resetModules();
  ({ applyTriageRecords, automaticDecisionPatch, missingDocumentNote, reconcileWaitingDocuments } = await import('./plan-queue-readiness'));
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  driver.close();
  rmSync(workspace, { recursive: true, force: true });
});

describe('automaticDecisionPatch', () => {
  it.each([
    'May the worker publish the release to the production store?',
    'Should we upgrade the Vercel plan to Pro?',
    'Can we skip an acceptance criterion?',
    'May the worker delete the old database records?',
  ])('keeps a risky technical question manual: %s', (question) => {
    expect(automaticDecisionPatch({ ...technicalQuestion(), question })).toBeNull();
  });

  it.each(['missing', 'skip'])('does not auto-answer an invalid %s recommendation', (recommendedOptionId) => {
    const question = technicalQuestion();
    expect(automaticDecisionPatch({ ...question, decision: { kind: 'technical', recommendedOptionId, reason: 'Routine choice.', evidence: 'AGENTS.md documents the runner.' } })).toBeNull();
  });

  it('does not auto-answer duplicate option IDs', () => {
    const question = technicalQuestion();
    expect(automaticDecisionPatch({ ...question, options: [{ id: 'quiet', label: 'First' }, { id: 'quiet', label: 'Second' }] })).toBeNull();
  });

  it('keeps legacy questions manual', () => {
    const question = technicalQuestion();
    expect(automaticDecisionPatch({ question: question.question, options: question.options })).toBeNull();
  });

  it.each(['human-authority', 'human-input'] as const)('keeps %s questions manual', (kind) => {
    expect(automaticDecisionPatch({ ...technicalQuestion(), decision: { kind, reason: 'Only James can supply this.' } })).toBeNull();
  });

  it('keeps maximum-size accepted decision audits within DTO bounds with question, label, reason and evidence', () => {
    const id = 'q'.repeat(50);
    const label = 'LABEL '.padEnd(500, 'l');
    const reason = 'REASON '.padEnd(4000, 'r');
    const evidence = 'EVIDENCE '.padEnd(8000, 'e');
    const question = PlanQueueQuestionSchema.parse({
      question: 'QUESTION '.padEnd(2000, 'q'),
      options: [{ id, label }, { id: 'skip', label: 'Leave it alone' }],
      decision: { kind: 'technical', recommendedOptionId: id, reason, evidence },
    });
    const patch = automaticDecisionPatch(question)!;
    const dto = PlanQueueItemDtoSchema.parse({ ...addItem(), ...patch, state: 'queued' });
    expect(dto.answer!.length).toBeLessThanOrEqual(2000);
    expect(dto.detail!.length).toBeLessThanOrEqual(8000);
    expect(dto.answer).toContain(label);
    expect(dto.answer).toContain(question.question.slice(0, 400));
    expect(dto.answer).toContain(reason.slice(0, 450));
    expect(dto.answer).toContain(evidence.slice(0, 450));
    expect(dto.detail).toContain(question.question.slice(0, 1000));
    expect(dto.detail).toContain(reason.slice(0, 1500));
    expect(dto.detail).toContain(evidence.slice(0, 4500));
    expect(dto.question).toBeNull();
    expect(dto.verdict).toBeNull();
  });
});

describe('applyTriageRecords', () => {
  it('records an automatic choice reported after a run is paused without asking James', () => {
    const item = addItem();
    store.upsertRun({ ...run, status: 'paused' });
    const result = applyTriageRecords(host, run, { run_id: run.id, records: [
      { documentPath: item.sourceRef, disposition: 'needs-answer', question: technicalQuestion() },
    ] });
    expect(result).toEqual({ applied: 1, unmatched: [] });
    expect(host.getItem(item.id)).toMatchObject({ state: 'queued', question: null });
    expect(host.getRun(run.id).status).toBe('paused');
    expect(host.notifyParent).not.toHaveBeenCalled();
  });

  it('rejects a report after cancellation without changing the current row', () => {
    const item = addItem();
    store.upsertRun({ ...run, status: 'cancelled', endedAt: 2 });
    const before = host.getItem(item.id);
    const result = applyTriageRecords(host, run, { run_id: run.id, records: [
      { documentPath: item.sourceRef, disposition: 'needs-answer', question: technicalQuestion() },
    ] });
    expect(result).toEqual({ applied: 0, unmatched: [item.sourceRef] });
    expect(host.getItem(item.id)).toEqual(before);
    expect(host.transition).not.toHaveBeenCalled();
    expect(host.notifyParent).not.toHaveBeenCalled();
  });

  it('re-reads a duplicate record instead of overwriting a decision already applied', () => {
    const item = addItem();
    const result = applyTriageRecords(host, run, { run_id: run.id, records: [
      { documentPath: item.sourceRef, disposition: 'needs-answer', question: technicalQuestion() },
      { documentPath: item.sourceRef, disposition: 'skip', reason: 'A later duplicate must not replace the applied decision.' },
    ] });
    expect(result).toEqual({ applied: 1, unmatched: [item.sourceRef] });
    expect(host.getItem(item.id)).toMatchObject({ state: 'queued', question: null });
    expect(host.getItem(item.id).answer).toContain('Use the documented quiet runner');
    expect(host.transition).toHaveBeenCalledTimes(1);
    expect(host.notifyParent).not.toHaveBeenCalled();
  });
});

describe('reconcileWaitingDocuments', () => {
  it('refuses a regular document reached through a directory link outside the workspace', async () => {
    const external = mkdtempSync(path.join(tmpdir(), 'aio-readiness-outside-'));
    try {
      writeFileSync(path.join(external, 'a_plan.md'), 'outside');
      symlinkSync(external, path.join(workspace, 'linked'));
      const item = addItem({ state: 'queued', sourceRef: path.join(workspace, 'linked', 'a_plan.md') });
      await reconcileWaitingDocuments(host, run);
      expect(host.getItem(item.id)).toMatchObject({ state: 'parked', parkReason: 'worker-error' });
      expect(host.getItem(item.id).detail).toMatch(/outside/i);
    } finally { rmSync(external, { recursive: true, force: true }); }
  });
  it.each(['EACCES', 'EMFILE', 'EIO'])('tries again on a %s read, which says nothing about the document and would hit every job at once', async code => {
    const item = addItem({ state: 'needs-answer', question: technicalQuestion() });
    writeFileSync(item.sourceRef, 'Active plan');
    vi.mocked(realFs.lstat).mockRejectedValueOnce(Object.assign(new Error('Could not read'), { code }));
    await reconcileWaitingDocuments(host, run);
    expect(host.getItem(item.id)).toMatchObject({ state: 'needs-answer', parkReason: null });
    expect(realFs.lstat).toHaveBeenCalledTimes(1);
  });

  it('parks a directory masquerading as a document', async () => {
    const item = addItem();
    mkdirSync(item.sourceRef);
    await reconcileWaitingDocuments(host, run);
    expect(host.getItem(item.id)).toMatchObject({ state: 'parked', parkReason: 'worker-error', verdict: null });
    expect(host.getItem(item.id).detail).toContain('not a regular file');
  });

  it('leaves a branch-owned queued item alone even when its source is missing', async () => {
    const item = addItem({ state: 'queued', branchName: 'queue/already-owned', answer: 'Existing decision' });
    await reconcileWaitingDocuments(host, run);
    expect(host.getItem(item.id)).toMatchObject({ state: 'queued', branchName: 'queue/already-owned', answer: 'Existing decision' });
    expect(realFs.lstat).not.toHaveBeenCalled();
    expect(host.transition).not.toHaveBeenCalled();
  });

  it('preserves cancellation that occurs while a filesystem check is pending', async () => {
    const item = addItem({ state: 'needs-answer', question: technicalQuestion() });
    writeFileSync(item.sourceRef.replace(/\.md$/, '_completed.md'), 'Completed successor');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(realFs.lstat).mockImplementationOnce(async (file) => {
      await gate;
      return originalLstat(file);
    });
    const reconciliation = reconcileWaitingDocuments(host, run);
    expect(realFs.lstat).toHaveBeenCalledWith(item.sourceRef);
    store.upsertRun({ ...run, status: 'cancelled', endedAt: 2 });
    store.upsertItem({ ...item, state: 'skipped', question: null, detail: 'Run cancelled by James.' });
    release();
    await reconciliation;
    expect(host.getItem(item.id)).toMatchObject({ state: 'skipped', question: null, detail: 'Run cancelled by James.', verdict: null });
    expect(host.transition).not.toHaveBeenCalled();
  });

  it('retires only an exact completed replacement without inventing PASS evidence', async () => {
    const item = addItem({ state: 'needs-answer', question: technicalQuestion() });
    const completed = item.sourceRef.replace(/\.md$/, '_completed.md');
    writeFileSync(completed, 'Closed document');
    await reconcileWaitingDocuments(host, run);
    expect(host.getItem(item.id)).toMatchObject({ state: 'skipped', question: null, verdict: null, answer: null, landedCommit: null });
    expect(host.getItem(item.id).detail).toContain(completed);
    expect(host.getItem(item.id).detail).toContain('not a verification verdict');
  });

  it('parks a missing source when only a similarly named completed document exists', async () => {
    const item = addItem();
    writeFileSync(path.join(workspace, 'a_plan_followup_completed.md'), 'Different completed document');
    await reconcileWaitingDocuments(host, run);
    expect(host.getItem(item.id)).toMatchObject({ state: 'parked', parkReason: 'missing-document', verdict: null });
    expect(host.getItem(item.id).detail).toContain('no exact completed replacement');
  });

  it('says what became of a started job\'s document', async () => {
    const document = path.join(workspace, 'started_plan.md');
    expect(await missingDocumentNote(document, workspace)).toContain('no exact completed replacement');
    writeFileSync(document.replace(/\.md$/, '_completed.md'), 'Closed document');
    expect(await missingDocumentNote(document, workspace)).toContain('closed as started_plan_completed.md');
    writeFileSync(document, 'Active plan');
    expect(await missingDocumentNote(document, workspace)).toBeNull();
  });

  it('retains an active source when a completed sibling also exists', async () => {
    const item = addItem({ state: 'needs-answer', question: { ...technicalQuestion(), decision: { kind: 'human-input', reason: 'Needs a human fact.' } } });
    writeFileSync(item.sourceRef, 'Active plan');
    writeFileSync(item.sourceRef.replace(/\.md$/, '_completed.md'), 'Closed sibling');
    await reconcileWaitingDocuments(host, run);
    expect(host.getItem(item.id)).toMatchObject({ state: 'needs-answer', question: item.question, verdict: null });
    expect(host.transition).not.toHaveBeenCalled();
  });
});
