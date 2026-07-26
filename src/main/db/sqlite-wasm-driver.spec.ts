import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LocalAiHealthRepository } from '../local-ai-guard/local-ai-health-repository';
import { RLM_MIGRATIONS_051_055 } from '../persistence/rlm/rlm-migrations-051-055';
import type { SqliteDriver } from './sqlite-driver';
import { createSqliteWasmDatabase, initSqliteWasm } from './sqlite-wasm-driver';

const dbs: SqliteDriver[] = [];

function openDb(): SqliteDriver {
  const db = createSqliteWasmDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON; CREATE TABLE markers (value TEXT NOT NULL);');
  dbs.push(db);
  return db;
}

describe('SqliteWasmDriver nested transactions', () => {
  beforeAll(async () => {
    await initSqliteWasm();
  });

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('commits nested work with savepoint semantics', () => {
    const db = openDb();
    const inner = db.transaction(() => db.prepare('INSERT INTO markers (value) VALUES (?)').run('inner'));
    const outer = db.transaction(() => {
      db.prepare('INSERT INTO markers (value) VALUES (?)').run('outer');
      inner();
    });

    outer();

    expect(db.prepare('SELECT value FROM markers ORDER BY rowid').all<{ value: string }>()).toEqual([
      { value: 'outer' }, { value: 'inner' },
    ]);
  });

  it('rolls back only a failed inner transaction and preserves outer work', () => {
    const db = openDb();
    const inner = db.transaction(() => {
      db.prepare('INSERT INTO markers (value) VALUES (?)').run('discarded');
      throw new Error('inner failed');
    });
    const outer = db.transaction(() => {
      db.prepare('INSERT INTO markers (value) VALUES (?)').run('before');
      expect(inner).toThrow('inner failed');
      db.prepare('INSERT INTO markers (value) VALUES (?)').run('after');
    });

    outer();

    expect(db.prepare('SELECT value FROM markers ORDER BY rowid').all<{ value: string }>()).toEqual([
      { value: 'before' }, { value: 'after' },
    ]);
  });

  it('rolls back successful inner work with a failing outer transaction and resets depth for a later transaction', () => {
    const db = openDb();
    const inner = db.transaction(() => db.prepare('INSERT INTO markers (value) VALUES (?)').run('inner'));
    const outer = db.transaction(() => {
      db.prepare('INSERT INTO markers (value) VALUES (?)').run('outer');
      inner();
      throw new Error('outer failed');
    });

    expect(outer).toThrow('outer failed');
    expect(db.prepare('SELECT value FROM markers').all()).toEqual([]);

    db.transaction(() => db.prepare('INSERT INTO markers (value) VALUES (?)').run('later'))();
    expect(db.prepare('SELECT value FROM markers').all<{ value: string }>()).toEqual([{ value: 'later' }]);
  });

  it('lets an outer transaction recover after an inner repository write fails', () => {
    const db = openDb();
    const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
    if (!migration) throw new Error('Missing migration 054_local_ai_guard');
    db.exec(migration.up);
    const repository = new LocalAiHealthRepository(db);
    const outer = db.transaction(() => {
      db.prepare('INSERT INTO markers (value) VALUES (?)').run('before');
      expect(() => repository.upsertIncident({
        kind: 'open-or-update',
        incident: {
          id: 'missing-target-incident', targetId: 'missing-target', state: 'open', severity: 'critical',
          failureCode: 'endpoint-timeout', affectedLayers: ['endpoint'], affectedRoles: ['compression'],
          openedAt: 1, updatedAt: 1, fallbackCount: 0, knownCostUsd: 0, estimatedCostUsd: 0,
        },
      })).toThrow();
      db.prepare('INSERT INTO markers (value) VALUES (?)').run('after');
    });

    outer();

    expect(db.prepare('SELECT value FROM markers ORDER BY rowid').all<{ value: string }>()).toEqual([
      { value: 'before' }, { value: 'after' },
    ]);
  });
});
