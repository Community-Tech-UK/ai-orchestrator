import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from './rlm-schema';

const dbs: SqliteDriver[] = [];

function openMigratedDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

describe('workspace secrets migration 061', () => {
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('registers, creates both tables and indexes, and is idempotent on re-run', () => {
    const db = openMigratedDb();
    runMigrations(db); // second run must be a no-op

    expect(
      db.prepare('SELECT name FROM _migrations WHERE name = ?').get<{ name: string }>('061_workspace_secrets'),
    ).toEqual({ name: '061_workspace_secrets' });

    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('workspace_secrets', 'workspace_secret_audit')
      ORDER BY name
    `).all<{ name: string }>().map((row) => row.name);
    expect(tables).toEqual(['workspace_secret_audit', 'workspace_secrets']);

    const indexes = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'idx_workspace_secret%'
      ORDER BY name
    `).all<{ name: string }>().map((row) => row.name);
    expect(indexes).toEqual([
      'idx_workspace_secret_audit_secret',
      'idx_workspace_secret_audit_workspace',
      'idx_workspace_secrets_workspace',
    ]);
  });

  it('enforces one secret per (workspace, name)', () => {
    const db = openMigratedDb();
    const insert = `
      INSERT INTO workspace_secrets (id, workspace_id, name, label, purpose, value_enc, created_at, updated_at)
      VALUES (?, ?, ?, '', '', 'ciphertext', 1, 1)
    `;
    db.prepare(insert).run('s1', '/ws/a', 'github-pat');

    expect(() => db.prepare(insert).run('s2', '/ws/a', 'github-pat')).toThrow();

    // Same name in a different workspace is a different secret, which is the whole
    // point of per-workspace scoping.
    expect(() => db.prepare(insert).run('s3', '/ws/b', 'github-pat')).not.toThrow();
  });

  it('constrains audit events to the known set', () => {
    const db = openMigratedDb();
    const insert = `
      INSERT INTO workspace_secret_audit (id, workspace_id, secret_name, event, purpose, at)
      VALUES (?, '/ws/a', 'github-pat', ?, '', 1)
    `;

    for (const event of ['created', 'updated', 'resolved', 'declined', 'forgotten']) {
      expect(() => db.prepare(insert).run(`a-${event}`, event)).not.toThrow();
    }

    expect(() => db.prepare(insert).run('a-bad', 'exfiltrated')).toThrow();
  });

  it('has no column that could hold a plaintext value', () => {
    const db = openMigratedDb();
    const columns = db.prepare(`PRAGMA table_info(workspace_secrets)`).all<{ name: string }>()
      .map((row) => row.name);

    expect(columns).toContain('value_enc');
    expect(columns).not.toContain('value');
    expect(columns).not.toContain('plaintext');

    const auditColumns = db.prepare(`PRAGMA table_info(workspace_secret_audit)`).all<{ name: string }>()
      .map((row) => row.name);
    expect(auditColumns).not.toContain('value');
    expect(auditColumns).not.toContain('value_enc');
  });
});
