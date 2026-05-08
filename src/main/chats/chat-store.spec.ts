import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createOperatorTables } from '../operator/operator-schema';
import { ChatStore } from './chat-store';

interface TableInfoRow { name: string; }

const PRE_MIGRATION_CHATS_DDL = [
  'CREATE TABLE chats (',
  '  id TEXT PRIMARY KEY,',
  '  name TEXT NOT NULL,',
  '  provider TEXT,',
  '  model TEXT,',
  '  current_cwd TEXT,',
  '  project_id TEXT,',
  '  yolo INTEGER NOT NULL DEFAULT 0,',
  '  ledger_thread_id TEXT NOT NULL UNIQUE,',
  '  current_instance_id TEXT,',
  '  created_at INTEGER NOT NULL,',
  '  last_active_at INTEGER NOT NULL,',
  '  archived_at INTEGER',
  ')',
].join('\n');

describe('ChatStore reasoning_effort column', () => {
  const dbs: SqliteDriver[] = [];

  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function freshDb(): SqliteDriver {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    return db;
  }

  it('creates the reasoning_effort column on a fresh schema', () => {
    const db = freshDb();
    createOperatorTables(db);

    const columns = db
      .prepare('PRAGMA table_info(chats)')
      .all() as TableInfoRow[];
    expect(columns.map(c => c.name)).toContain('reasoning_effort');
  });

  it('migrates a pre-existing chats table without the reasoning_effort column', () => {
    const db = freshDb();

    db.exec(PRE_MIGRATION_CHATS_DDL);

    db.prepare(`
      INSERT INTO chats (
        id, name, provider, model, current_cwd, project_id, yolo,
        ledger_thread_id, current_instance_id, created_at, last_active_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'pre-existing',
      'Old chat',
      'claude',
      'opus',
      '/work',
      null,
      0,
      'thread-pre',
      null,
      1000,
      1000,
      null,
    );

    createOperatorTables(db);

    const columns = db
      .prepare('PRAGMA table_info(chats)')
      .all() as TableInfoRow[];
    expect(columns.map(c => c.name)).toContain('reasoning_effort');

    const store = new ChatStore(db);
    const row = store.get('pre-existing');
    expect(row?.reasoningEffort).toBeNull();
  });

  it('round-trips reasoningEffort on insert and update', () => {
    const db = freshDb();
    createOperatorTables(db);
    const store = new ChatStore(db);

    const inserted = store.insert({
      id: 'chat-1',
      name: 'Picker chat',
      provider: 'claude',
      currentCwd: '/work',
      ledgerThreadId: 'thread-1',
    });
    expect(inserted.reasoningEffort).toBeNull();

    const updated = store.update('chat-1', { reasoningEffort: 'high' });
    expect(updated.reasoningEffort).toBe('high');

    const refetched = store.get('chat-1');
    expect(refetched?.reasoningEffort).toBe('high');

    const cleared = store.update('chat-1', { reasoningEffort: null });
    expect(cleared.reasoningEffort).toBeNull();
  });

  it('inserts with explicit reasoningEffort', () => {
    const db = freshDb();
    createOperatorTables(db);
    const store = new ChatStore(db);

    const inserted = store.insert({
      id: 'chat-2',
      name: 'Codex chat',
      provider: 'codex',
      reasoningEffort: 'medium',
      currentCwd: '/work',
      ledgerThreadId: 'thread-2',
    });
    expect(inserted.reasoningEffort).toBe('medium');
  });

  it('coerces unknown reasoning_effort strings in the row to null', () => {
    const db = freshDb();
    createOperatorTables(db);

    db.prepare(`
      INSERT INTO chats (
        id, name, provider, model, reasoning_effort, current_cwd, project_id, yolo,
        ledger_thread_id, current_instance_id, created_at, last_active_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'chat-3',
      'Garbage reasoning',
      'claude',
      null,
      'garbage-value',
      '/work',
      null,
      0,
      'thread-3',
      null,
      1000,
      1000,
      null,
    );

    const store = new ChatStore(db);
    expect(store.get('chat-3')?.reasoningEffort).toBeNull();
  });
});
