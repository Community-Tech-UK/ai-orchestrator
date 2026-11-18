import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { LOOP_SCHEMA_VERSION, runLoopMigrations, runLoopMigrationsUpTo } from '../orchestration/loop-schema';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import { hashTicketText } from './plan-queue-linear-ticket-hash';
import type { ApprovedTicketText } from './plan-queue-ticket-approved-text';
import { PlanQueueLinearTicketStore, type NewPlanQueueLinearTicket, type OpenTicketAsk } from './plan-queue-linear-ticket-store';

let db: SqliteDriver;
let queue: PlanQueueStore;
let tickets: PlanQueueLinearTicketStore;

const text: ApprovedTicketText = { description: 'The button does nothing.', comments: [
  { id: 'c1', authorId: 'user-1', authorName: 'Sam', body: 'Seen on Safari too.', createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z', fromBot: false },
], labels: ['Harness'], priority: 2, projectName: 'Website', relatedTickets: [{ relation: 'blocked-by', identifier: 'ORC-3', title: null }], attachmentNames: [] };
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
    const ask = { kind: 'changed', heldTitle: 'Fix the sign-in page', heldText: { ...text, description: 'Changed.' }, heldHash: hashOf('Fix the sign-in page', 'Changed.'),
      changed: ['title', 'description'], openedAt: 500 } satisfies OpenTicketAsk;

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

    it('opens and reads back a question for a ticket that has gone, or whose text cannot be confirmed, with no text in it', () => {
      for (const kind of ['gone', 'unconfirmed'] as const) {
        addItem(`item-${kind}`);
        tickets.insert(ticket(`item-${kind}`, `lin-${kind}`));
        tickets.openAsk(`item-${kind}`, { kind, openedAt: 500 });
        expect(tickets.get(`item-${kind}`)?.openAsk).toEqual({ kind, openedAt: 500 });
        expect(db.prepare('SELECT open_ask_json FROM plan_queue_linear_tickets WHERE item_id = ?').get<{ open_ask_json: string }>(`item-${kind}`)?.open_ask_json)
          .toBe(JSON.stringify({ kind, openedAt: 500 }));
      }
    });

    it('refuses a question of an unknown kind, and one of a kind that carries text but has none', () => {
      addItem('item-1');
      tickets.insert(ticket('item-1'));
      expect(() => tickets.openAsk('item-1', { kind: 'other', openedAt: 1 } as never)).toThrow();
      expect(() => tickets.openAsk('item-1', { kind: 'changed', openedAt: 1 } as never)).toThrow();
      expect(tickets.get('item-1')?.openAsk).toBeNull();
    });

    it('refuses a question that names no kind of change', () => {
      addItem('item-1');
      tickets.insert(ticket('item-1'));
      expect(() => tickets.openAsk('item-1', { ...ask, changed: [] })).toThrow();
    });
  });

  describe('what the pump asks about a job', () => {
    const blockedText = { ...text, relatedTickets: [
      { relation: 'blocked-by' as const, identifier: 'ORC-3', title: null }, { relation: 'blocks' as const, identifier: 'ORC-9', title: null },
      { relation: 'blocked-by' as const, identifier: 'COM-5', title: null }] };

    it('answers the address, the kind of question open and the tickets it is blocked by, from the table', () => {
      addItem('item-1');
      tickets.insert(ticket('item-1', 'lin-1', { approvedText: blockedText }));
      expect(tickets.holdState('item-1')).toEqual({ identifier: 'ORC-7', askKind: null, blockedBy: ['ORC-3', 'COM-5'] });
      tickets.openAsk('item-1', { kind: 'gone', openedAt: 5 });
      expect(tickets.holdState('item-1')).toMatchObject({ askKind: 'gone' });
      tickets.closeAsk('item-1', null);
      expect(tickets.holdState('item-1')?.askKind).toBeNull();
    });

    it('answers nothing for a job with no row, and no blockers for a job whose text was cleared', () => {
      expect(tickets.holdState('ghost')).toBeUndefined();
      addItem('item-1');
      tickets.insert(ticket('item-1', 'lin-1', { approvedText: blockedText }));
      tickets.clearText('item-1', 9);
      expect(tickets.holdState('item-1')).toEqual({ identifier: 'ORC-7', askKind: null, blockedBy: [] });
    });

    it('finds the job that holds each ticket of one run, and none of another run\'s', () => {
      addItem('item-1');
      tickets.insert(ticket('item-1'));
      queue.upsertRun({ id: 'run-2', parentInstanceId: 'owner', parentHistoryThreadId: null, kind: 'tickets', workspaceCwd: '/repo', status: 'running',
        config: DEFAULT_PLAN_QUEUE_CONFIG.tickets, relaxation: null, workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: null });
      queue.upsertItem(newPlanQueueItem('item-2', 'run-2', 'linear:lin-2', 1));
      tickets.insert(ticket('item-2', 'lin-2', { identifier: 'ORC-8' }));
      expect([...tickets.itemIdsByIdentifier('run-1')]).toEqual([['ORC-7', 'item-1']]);
      expect([...tickets.itemIdsByIdentifier('run-2')]).toEqual([['ORC-8', 'item-2']]);
    });
  });

  it('clears the approved text and any held text, and keeps the title, hash and times', () => {
    addItem('item-1');
    tickets.insert(ticket('item-1'));
    tickets.openAsk('item-1', { kind: 'changed', heldTitle: 'T', heldText: text, heldHash: hashOf('T'), changed: ['title'], openedAt: 500 });
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

    it('reports when the newest landed item was last saved as when it landed', () => {
      addItem('landed', { state: 'landed', createdAt: 10, landedCommit: 'aaa111' });
      tickets.insert(ticket('landed'));
      const saved = queue.getItem('landed')!.updatedAt;
      expect(saved).toBeGreaterThan(0);
      expect(tickets.findLatestLandedItem('lin-1')?.landedAt).toBe(saved);
    });

    it('names a ticket from its newest row: the identifier and the approved title', () => {
      addItem('old', { createdAt: 10 });
      addItem('new', { createdAt: 50 });
      tickets.insert({ ...ticket('old'), approvedTitle: 'Old title' });
      tickets.insert({ ...ticket('new'), approvedTitle: 'New title' });
      expect(tickets.findNames('lin-1')).toEqual({ identifier: 'ORC-7', approvedTitle: 'New title' });
      expect(tickets.findNames('lin-other')).toBeUndefined();
    });

    it('lists each team that has a ticket in a run once, with one of its addresses, and leaves other runs out', () => {
      queue.upsertRun({ id: 'run-2', parentInstanceId: 'owner', parentHistoryThreadId: null, kind: 'tickets', workspaceCwd: '/repo', status: 'running',
        config: DEFAULT_PLAN_QUEUE_CONFIG.tickets, relaxation: null, workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: null });
      addItem('a'); addItem('b'); addItem('c');
      queue.upsertItem(newPlanQueueItem('other', 'run-2', 'linear:other', 1));
      tickets.insert(ticket('a', 'lin-a', { identifier: 'ORC-9', teamId: 'team-orc' }));
      tickets.insert(ticket('b', 'lin-b', { identifier: 'ORC-4', teamId: 'team-orc' }));
      tickets.insert(ticket('c', 'lin-c', { identifier: 'COM-2', teamId: 'team-com' }));
      tickets.insert(ticket('other', 'lin-d', { identifier: 'ZZZ-1', teamId: 'team-zzz' }));
      expect(tickets.teamsOfRun('run-1')).toEqual([{ teamId: 'team-com', identifier: 'COM-2' }, { teamId: 'team-orc', identifier: 'ORC-4' }]);
      expect(tickets.teamsOfRun('run-2')).toEqual([{ teamId: 'team-zzz', identifier: 'ZZZ-1' }]);
      expect(tickets.teamsOfRun('none')).toEqual([]);
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
