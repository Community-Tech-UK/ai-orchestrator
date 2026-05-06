import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../rlm-schema';

const dbs: SqliteDriver[] = [];

function openMigratedDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

describe('MCP RLM migrations', () => {
  afterEach(() => {
    for (const db of dbs.splice(0)) {
      db.close();
    }
  });

  it('creates orchestrator_mcp_servers with expected columns and scope check', () => {
    const db = openMigratedDb();
    const columns = db.prepare('PRAGMA table_info(orchestrator_mcp_servers)').all<{ name: string }>();
    expect(columns.map((column) => column.name)).toEqual([
      'id',
      'name',
      'description',
      'scope',
      'transport',
      'command',
      'args_json',
      'url',
      'headers_json',
      'env_json',
      'env_secrets_encrypted_json',
      'auto_connect',
      'inject_into_json',
      'created_at',
      'updated_at',
      'headers_secrets_encrypted_json',
    ]);

    expect(() => db.prepare(`
      INSERT INTO orchestrator_mcp_servers
        (id, name, scope, transport, auto_connect, inject_into_json, created_at, updated_at)
      VALUES ('bad', 'bad', 'user', 'stdio', 0, '[]', 1, 1)
    `).run()).toThrow();
  });

  it('creates shared_mcp_servers with target and HTTP fields', () => {
    const db = openMigratedDb();
    const columns = db.prepare('PRAGMA table_info(shared_mcp_servers)').all<{ name: string }>();
    expect(columns.map((column) => column.name)).toEqual([
      'id',
      'name',
      'description',
      'transport',
      'command',
      'args_json',
      'url',
      'headers_json',
      'env_json',
      'env_secrets_encrypted_json',
      'targets_json',
      'created_at',
      'updated_at',
      'headers_secrets_encrypted_json',
    ]);
  });
});
