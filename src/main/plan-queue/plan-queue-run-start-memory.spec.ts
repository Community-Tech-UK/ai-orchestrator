import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { claimDocumentsAndCreateItems } from './plan-queue-run-start';
import { PlanQueueStore } from './plan-queue-store';
import { rememberJamesAnswer, rememberTriageRecord } from './plan-queue-triage-memory';
import type { PlanQueueRun } from './plan-queue.types';

// 14 Oct 2026, noon UTC: the same calendar day in every timezone the tests run in.
const DECIDED_AT = Date.UTC(2026, 9, 14, 12);
const question = {
  question: 'Is this work already started?',
  options: [{ id: 'started', label: 'It is started' }, { id: 'skip', label: 'Skip it' }],
};

let db: SqliteDriver;
let store: PlanQueueStore;
let folder: string;
let document: string;

beforeAll(() => initSqliteWasm());
beforeEach(() => {
  db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db);
  store = new PlanQueueStore(db);
  folder = mkdtempSync(join(tmpdir(), 'queue-run-memory-'));
  document = join(folder, 'work_plan.md');
  writeFileSync(document, '# Work\n');
});
afterEach(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });

function startRun(id: string, queueDirectly: boolean) {
  const run: PlanQueueRun = {
    id, parentInstanceId: `parent-${id}`, parentHistoryThreadId: null, kind: 'plans', workspaceCwd: folder,
    status: 'running', config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null, workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: null,
  };
  store.upsertRun(run);
  claimDocumentsAndCreateItems({ store, memory: store.history, now: () => 100, newId: () => `${id}-item` }, run,
    [{ ref: document, readiness: 'candidate' }], { queueDirectly });
  return store.listItems(id)[0];
}

describe('an unchanged document reuses what an earlier run decided', () => {
  it('queues a document triage found ready, saying when it was decided', () => {
    rememberTriageRecord(store.history, document, folder, { disposition: 'ready' }, DECIDED_AT);
    expect(startRun('again', false)).toMatchObject({ state: 'queued', detail: 'Already decided on 14 Oct: ready to work on.' });
  });

  it('leaves out a document triage decided to skip, with the same reason', () => {
    rememberTriageRecord(store.history, document, folder, { disposition: 'skip', reason: 'Superseded by a newer plan.' }, DECIDED_AT);
    expect(startRun('again', false)).toMatchObject({ state: 'skipped', detail: 'Already decided on 14 Oct: Superseded by a newer plan.' });
  });

  it('applies the answer James gave, and hands it to the worker', () => {
    rememberTriageRecord(store.history, document, folder, { disposition: 'needs-answer', question }, DECIDED_AT);
    rememberJamesAnswer(store.history, { sourceRef: document }, folder, question.question, question.options[0], DECIDED_AT);
    expect(startRun('again', false)).toMatchObject({
      state: 'queued', detail: 'Already decided on 14 Oct: It is started', answer: 'Is this work already started? → It is started',
    });
  });

  it('asks again only for a question that was never answered', () => {
    rememberTriageRecord(store.history, document, folder, { disposition: 'needs-answer', question }, DECIDED_AT);
    expect(startRun('again', false)).toMatchObject({ state: 'needs-answer', question });
  });

  it('decides afresh once the document changes', () => {
    rememberTriageRecord(store.history, document, folder, { disposition: 'skip', reason: 'Superseded.' }, DECIDED_AT);
    writeFileSync(document, '# Work\n\nA new step.\n');
    expect(startRun('again', false)).toMatchObject({ state: 'discovered', detail: null });
  });

  it('decides afresh once the linked spec changes', () => {
    const spec = join(folder, 'work_spec_planned.md');
    writeFileSync(spec, 'first');
    rememberTriageRecord(store.history, document, folder, { disposition: 'skip', reason: 'Superseded.' }, DECIDED_AT);
    expect(startRun('same', false)).toMatchObject({ state: 'skipped' });
    store.upsertRun({ ...store.getRun('same')!, status: 'completed', endedAt: 2 });
    writeFileSync(spec, 'second');
    expect(startRun('changed', false)).toMatchObject({ state: 'discovered' });
  });

  it('does not consult the memory for a single-path run, which queues directly', () => {
    rememberTriageRecord(store.history, document, folder, { disposition: 'skip', reason: 'Superseded.' }, DECIDED_AT);
    expect(startRun('direct', true)).toMatchObject({ state: 'queued' });
  });
});
