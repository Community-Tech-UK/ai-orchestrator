import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { LOOP_SCHEMA_VERSION, runLoopMigrations, runLoopMigrationsUpTo } from '../orchestration/loop-schema';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import { hashTicketText } from './plan-queue-linear-ticket-hash';
import { PlanQueueLinearTicketStore, type NewPlanQueueLinearTicket, type OpenTicketAsk } from './plan-queue-linear-ticket-store';

let db: SqliteDriver;
let queue: PlanQueueStore;
let tickets: PlanQueueLinearTicketStore;

const text = { description: 'The button does nothing.', comments: [
  { id: 'c1', authorId: 'user-1', authorName: 'Sam', body: 'Seen on Safari too.', createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z', fromBot: false },
] };
const hashOf = (title: string, description = text.description) => hashTicketText({ title, description, comments: text.comments });

function ticket(itemId: string, linearId = 'lin-1', over: Partial<NewPlanQueueLinearTicket> = {}): NewPlanQueueLinearTicket {
  return { itemId, linearId, identifier: 'ORC-7', address: 'https://linear.app/x/issue/ORC-7', teamId: 'team-1', projectId: 'proj-1',
    approvedTitle: 'Fix the login page', approvedText: text, approvedHash: hashOf('Fix the login page'), approvedAt: 100, ...over };
}

function addItem(id: string, over: Partial<ReturnType<typeof newPlanQueueItem>> = {}): void {
  queue.upsertItem(newPlanQueueItem(id, 'run-1', `linear:${id}`, 1, over));
}

beforeEach(() => {
  db = new Database(':memory:') as unknown as SqliteDriver;
  db.pragma('foreign_keys = ON');
  runLoopMigrations(db);
  queue = new PlanQueueStore(db);
  tickets = new PlanQueueLinearTicketStore(db);
  queue.upsertRun({ id: 'run-1', parentInstanceId: 'owner', parentHistoryThreadId: null, kind: 'tickets', workspaceCwd: '/repo', status: 'running',
    config: DEFAULT_PLAN_QUEUE_CONFIG.tickets, relaxation: null, workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: null });
});
afterEach(() => db.close());

describe('the Linear ticket store', () => {
  it('reads back what was inserted, with the claim, question and clearing empty', () => {
    addItem('item-1');
    tickets.insert(ticket('item-1'));
    expect(tickets.get('item-1')).toEqual({ ...ticket('item-1'), claimedAt: null, openAsk: null, leftOutHash: null, textClearedAt: null });
    expect(tickets.get('nothing')).toBeUndefined();
  });

  it('refuses a second row for one item and leaves the first untouched', () => {
    addItem('item-1');
    tickets.insert(ticket('item-1'));
    expect(() => tickets.insert(ticket('item-1', 'lin-2', { approvedTitle: 'Another ticket' }))).toThrow(/UNIQUE|PRIMARY/i);
    expect(tickets.get('item-1')?.linearId).toBe('lin-1');
    expect(tickets.get('item-1')?.approvedTitle).toBe('Fix the login page');
  });

  it('records the claim once: a later call does not move the time', () => {
    addItem('item-1');
    tickets.insert(ticket('item-1'));
    expect(tickets.recordClaim('item-1', 200)).toBe(true);
    expect(tickets.recordClaim('item-1', 300)).toBe(false);
    expect(tickets.get('item-1')?.claimedAt).toBe(200);
  });

  it('replaces the approved text, title, hash and time together', () => {
    addItem('item-1');
    tickets.insert(ticket('item-1'));
    const next = { ...text, description: 'The button now needs a double click.' };
    tickets.replaceApprovedText('item-1', { title: 'Fix the sign-in page', text: next, hash: hashOf('Fix the sign-in page', next.description), approvedAt: 400 });
    expect(tickets.get('item-1')).toMatchObject({ approvedTitle: 'Fix the sign-in page', approvedText: next, approvedAt: 400,
      approvedHash: hashOf('Fix the sign-in page', next.description), textClearedAt: null });
  });

  describe('the question for James', () => {
    const ask: OpenTicketAsk = { heldTitle: 'Fix the sign-in page', heldText: { ...text, description: 'Changed.' }, heldHash: hashOf('Fix the sign-in page', 'Changed.'),
      changed: ['title', 'description'], openedAt: 500 };

    it('opens, reads back, and closes with the hash of a change James left out', () => {
      addItem('item-1');
      tickets.insert(ticket('item-1'));
      tickets.openAsk('item-1', ask);
      expect(tickets.get('item-1')?.openAsk).toEqual(ask);
      tickets.closeAsk('item-1', ask.heldHash);
      expect(tickets.get('item-1')).toMatchObject({ openAsk: null, leftOutHash: ask.heldHash });
    });

    it('closes without a left-out hash when James approved the change', () => {
      addItem('item-1');
      tickets.insert(ticket('item-1'));
      tickets.openAsk('item-1', ask);
      tickets.closeAsk('item-1', null);
      expect(tickets.get('item-1')).toMatchObject({ openAsk: null, leftOutHash: null });
    });

    it('refuses a second question while one is open, and keeps the first', () => {
      addItem('item-1');
      tickets.insert(ticket('item-1'));
      tickets.openAsk('item-1', ask);
      expect(() => tickets.openAsk('item-1', { ...ask, openedAt: 600 })).toThrow(/already open/);
      expect(tickets.get('item-1')?.openAsk?.openedAt).toBe(500);
    });

    it('refuses a question that names no kind of change', () => {
      addItem('item-1');
      tickets.insert(ticket('item-1'));
      expect(() => tickets.openAsk('item-1', { ...ask, changed: [] })).toThrow();
    });
  });

  it('clears the approved text and any held text, and keeps the title, hash and times', () => {
    addItem('item-1');
    tickets.insert(ticket('item-1'));
    tickets.openAsk('item-1', { heldTitle: 'T', heldText: text, heldHash: hashOf('T'), changed: ['title'], openedAt: 500 });
    tickets.clearText('item-1', 700);
    expect(tickets.get('item-1')).toMatchObject({ approvedText: null, openAsk: null, textClearedAt: 700,
      approvedTitle: 'Fix the login page', approvedHash: hashOf('Fix the login page'), approvedAt: 100 });
    const raw = db.prepare('SELECT approved_text_json, open_ask_json FROM plan_queue_linear_tickets WHERE item_id = ?').get('item-1');
    expect(raw).toEqual({ approved_text_json: null, open_ask_json: null });
  });

  it('says plainly which item has no row, without naming any ticket text', () => {
    for (const act of [() => tickets.recordClaim('ghost', 1), () => tickets.clearText('ghost', 1), () => tickets.closeAsk('ghost', null)]) {
      expect(act).toThrow('No Linear ticket row for item ghost.');
    }
  });

  it('deletes its row with its item', () => {
    addItem('item-1');
    addItem('item-2');
    tickets.insert(ticket('item-1'));
    tickets.insert(ticket('item-2', 'lin-2'));
    db.prepare('DELETE FROM plan_queue_items WHERE id = ?').run('item-1');
    expect(tickets.get('item-1')).toBeUndefined();
    expect(tickets.get('item-2')).toBeDefined();
  });

  it('keeps ticket text off the item row that status, the page and the phone are sent', () => {
    addItem('item-1');
    tickets.insert(ticket('item-1'));
    const item = JSON.stringify(queue.getItem('item-1'));
    expect(item).not.toContain('The button does nothing.');
    expect(item).not.toContain('Fix the login page');
  });

  describe('finding the item of a Linear id', () => {
    it('finds the unfinished item, and not a landed, parked or skipped one', () => {
      addItem('landed', { state: 'landed', createdAt: 10 });
      addItem('parked', { state: 'parked', createdAt: 20 });
      addItem('skipped', { state: 'skipped', createdAt: 30 });
      for (const id of ['landed', 'parked', 'skipped']) tickets.insert(ticket(id));
      expect(tickets.findUnfinishedItem('lin-1')).toBeUndefined();
      addItem('working', { state: 'working', createdAt: 40 });
      tickets.insert(ticket('working'));
      expect(tickets.findUnfinishedItem('lin-1')).toMatchObject({ itemId: 'working', runId: 'run-1', state: 'working' });
      expect(tickets.findUnfinishedItem('lin-other')).toBeUndefined();
    });

    it('sees a row written a moment earlier, with no wait in between (two starts at once)', () => {
      addItem('first', { state: 'queued' });
      addItem('second', { state: 'queued' });
      tickets.insert(ticket('first'));
      // What a second run's start asks, straight after the first run's write, in the same turn of the event loop.
      expect(tickets.findUnfinishedItem('lin-1')?.itemId).toBe('first');
      tickets.insert(ticket('second'));
      expect(tickets.findUnfinishedItem('lin-1')).toBeDefined();
    });

    it('finds the newest landed item, by when its attempt began, with its commit', () => {
      addItem('old', { state: 'landed', createdAt: 10, landedCommit: 'aaa111' });
      addItem('new', { state: 'landed', createdAt: 50, landedCommit: 'bbb222' });
      addItem('later-parked', { state: 'parked', createdAt: 90 });
      for (const id of ['old', 'new', 'later-parked']) tickets.insert(ticket(id));
      expect(tickets.findLatestLandedItem('lin-1')).toMatchObject({ itemId: 'new', landedCommit: 'bbb222', identifier: 'ORC-7', linearId: 'lin-1' });
      expect(tickets.findLatestLandedItem('lin-other')).toBeUndefined();
    });
  });
});

describe('migration 059, the ticket table', () => {
  // The outer beforeEach migrated fully; these tests need a database that has not seen 059 yet.
  beforeEach(() => {
    db.close();
    db = new Database(':memory:') as unknown as SqliteDriver;
    db.pragma('foreign_keys = ON');
  });

  /** A profile on the version before this migration, with a run, jobs and the history rows that point at them. */
  function profileBeforeTickets(): void {
    runLoopMigrationsUpTo(db, 58);
    db.prepare(`INSERT INTO plan_queue_runs (id, parent_instance_id, kind, workspace_cwd, status, config_json, started_at, updated_at)
      VALUES ('old-run', 'chat', 'plans', '/repo', 'running', '{}', 1, 1)`).run();
    db.prepare(`INSERT INTO plan_queue_items (id, run_id, document_path, state, round, created_at, updated_at, tokens)
      VALUES ('old-job', 'old-run', '/repo/docs/plans/a_plan.md', 'landed', 2, 5, 6, 77)`).run();
    db.prepare("INSERT INTO plan_queue_item_events (id, item_id, run_id, at, to_state, round, tokens) VALUES ('event-1', 'old-job', 'old-run', 5, 'landed', 2, 77)").run();
  }
  const counts = () => ['plan_queue_runs', 'plan_queue_items', 'plan_queue_item_events', 'plan_queue_verdicts', 'plan_queue_item_pins']
    .map((table) => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get<{ n: number }>()?.n]);

  it('adds the table and leaves every existing row and query as they were', () => {
    profileBeforeTickets();
    const before = { counts: counts(), items: db.prepare('SELECT * FROM plan_queue_items ORDER BY id').all(),
      runs: db.prepare('SELECT * FROM plan_queue_runs ORDER BY id').all(), events: db.prepare('SELECT * FROM plan_queue_item_events ORDER BY id').all() };
    runLoopMigrations(db);
    expect(counts()).toEqual(before.counts);
    expect(db.prepare('SELECT * FROM plan_queue_items ORDER BY id').all()).toEqual(before.items);
    expect(db.prepare('SELECT * FROM plan_queue_runs ORDER BY id').all()).toEqual(before.runs);
    expect(db.prepare('SELECT * FROM plan_queue_item_events ORDER BY id').all()).toEqual(before.events);
    expect(db.prepare('SELECT name FROM loop_migrations WHERE version = 59').get<{ name: string }>()?.name).toBe('059_plan_queue_linear_tickets');
    expect(LOOP_SCHEMA_VERSION).toBe(59);
    expect(db.prepare('SELECT COUNT(*) AS n FROM plan_queue_linear_tickets').get<{ n: number }>()?.n).toBe(0);
    expect(new PlanQueueStore(db).getItem('old-job')?.state).toBe('landed');
  });

  it('is not run twice', () => {
    profileBeforeTickets();
    runLoopMigrations(db);
    expect(() => runLoopMigrations(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM loop_migrations WHERE version = 59').get<{ n: number }>()?.n).toBe(1);
  });

  it('has an index on the Linear id', () => {
    runLoopMigrations(db);
    const indexes = db.prepare("PRAGMA index_list('plan_queue_linear_tickets')").all<{ name: string }>().map((index) => index.name);
    expect(indexes).toContain('idx_queue_linear_tickets_linear_id');
  });

  it('crash window: a migration interrupted part way leaves the old schema, with no table and no receipt', () => {
    profileBeforeTickets();
    // The table is created, then the receipt cannot be written (its name is taken): the whole transaction must roll back.
    db.prepare("INSERT INTO loop_migrations (version, name, applied_at) VALUES (900, '059_plan_queue_linear_tickets', 1)").run();
    expect(() => runLoopMigrations(db)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'plan_queue_linear_tickets'").get()).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM loop_migrations WHERE version = 59').get<{ n: number }>()?.n).toBe(0);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(new PlanQueueStore(db).getItem('old-job')?.state).toBe('landed');
  });
});
