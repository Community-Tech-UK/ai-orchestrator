import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { createCostLogSessionLinks } from './usage-insight-runtime';

const DAY = 86_400_000;
const SINCE = Date.parse('2026-10-13T12:00:00Z');

describe('createCostLogSessionLinks', () => {
  let db: SqliteDriver;
  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    // The real schema, so the query is checked against the real table and columns.
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
  });
  afterEach(() => db.close());

  let counter = 0;
  function entry(instanceId: string, sessionId: string, timestamp: number): void {
    counter += 1;
    db.prepare(`INSERT INTO cost_entries(id,timestamp,instance_id,session_id,model,input_tokens,output_tokens,cost)
      VALUES(?,?,?,?,?,?,?,?)`).run(`e${counter}`, timestamp, instanceId, sessionId, 'claude-opus-5', 10, 5, 0.01);
  }

  it('lists the Harness sessions that ran each Claude session, oldest to most recent', async () => {
    entry('inst-a', 'sess-1', SINCE + 1 * DAY);
    entry('inst-a', 'sess-1', SINCE + 2 * DAY);
    entry('inst-b', 'sess-1', SINCE + 3 * DAY);
    entry('inst-c', 'sess-2', SINCE + 1 * DAY);
    const { links, unavailable } = await createCostLogSessionLinks(() => db)(SINCE);
    expect(links.get('sess-1')).toEqual(['inst-a', 'inst-b']);
    expect(links.get('sess-2')).toEqual(['inst-c']);
    expect(unavailable).toBeUndefined();
  });

  it('orders by the latest use, not the first', async () => {
    entry('inst-a', 'sess-1', SINCE + 1 * DAY);
    entry('inst-b', 'sess-1', SINCE + 2 * DAY);
    entry('inst-a', 'sess-1', SINCE + 3 * DAY);
    expect((await createCostLogSessionLinks(() => db)(SINCE)).links.get('sess-1')).toEqual(['inst-b', 'inst-a']);
  });

  it('only looks at the window', async () => {
    entry('inst-old', 'sess-old', SINCE - 1);
    entry('inst-new', 'sess-new', SINCE);
    const { links } = await createCostLogSessionLinks(() => db)(SINCE);
    expect([...links.keys()]).toEqual(['sess-new']);
  });

  it('skips rows with no session or no Harness session', async () => {
    entry('inst-a', '', SINCE + DAY);
    entry('', 'sess-x', SINCE + DAY);
    expect((await createCostLogSessionLinks(() => db)(SINCE)).links.size).toBe(0);
  });

  it('gives no links, and says they are unavailable, instead of failing when the database cannot be read', async () => {
    const result = await createCostLogSessionLinks(() => { throw new Error('database is closed'); })(SINCE);
    expect(result.links.size).toBe(0);
    expect(result.unavailable).toBe(true);
  });
});
