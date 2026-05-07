import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createOperatorTables } from './operator-schema';
import { OperatorEventBus } from './operator-event-bus';
import { OperatorEventRelay } from './operator-event-relay';

describe('OperatorEventRelay', () => {
  const dbs: SqliteDriver[] = [];

  afterEach(() => {
    OperatorEventRelay._resetForTesting();
    OperatorEventBus._resetForTesting();
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  it('publishes operator events inserted by another process after startup', () => {
    const db = createDb();
    db.prepare(`
      INSERT INTO operator_run_events (id, run_id, node_id, kind, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('old-event', 'run-1', null, 'progress', '{"old":true}', 1);

    const relay = new OperatorEventRelay({ db, intervalMs: 60_000 });
    relay.start();
    const received: string[] = [];
    OperatorEventBus.getInstance().subscribe((payload) => {
      received.push(payload.event.id);
    });

    db.prepare(`
      INSERT INTO operator_run_events (id, run_id, node_id, kind, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('new-event', 'run-1', 'node-1', 'shell-command', '{"cmd":"git"}', 2);
    relay.poll();

    expect(received).toEqual(['new-event']);
  });

  function createDb(): SqliteDriver {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    dbs.push(db);
    return db;
  }
});
