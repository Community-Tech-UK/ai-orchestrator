import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { WakeContextBuilder, getWakeContextBuilder } from './wake-context-builder';

let db: SqliteDriver;
vi.mock('../persistence/rlm-database', () => ({ getRLMDatabase: () => ({ getRawDb: () => db }) }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn() }) }));

describe('Wake hint removal', () => {
  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
    WakeContextBuilder._resetForTesting();
  });
  afterEach(() => { WakeContextBuilder._resetForTesting(); db.close(); });

  it('migrates durable tombstones without deleting existing hints', () => {
    const wake = getWakeContextBuilder();
    const id = wake.addHint('Keep this note');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'wake_hint_tombstones'").get()).toBeDefined();
    expect(wake.getHint(id)?.content).toBe('Keep this note');
  });

  it('remembers removed content across builder restarts and spelling whitespace changes', () => {
    const wake = getWakeContextBuilder();
    const id = wake.addHint('Prefer Const  bindings', { room: '/project' });
    wake.removeHint(id);
    expect(wake.getHint(id)).toBeUndefined();
    WakeContextBuilder._resetForTesting();
    const restored = getWakeContextBuilder();
    expect(restored.isHintRemoved(' prefer const\nbindings ', '/project')).toBe(true);
    expect(restored.isHintRemoved('prefer const bindings', '/other-project')).toBe(false);
  });
});
