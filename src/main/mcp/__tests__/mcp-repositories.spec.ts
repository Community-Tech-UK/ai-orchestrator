import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../../persistence/rlm/rlm-schema';
import { McpSecretStorage } from '../secret-storage';
import { OrchestratorMcpRepository } from '../orchestrator-mcp-repository';
import { SharedMcpRepository } from '../shared-mcp-repository';

const dbs: SqliteDriver[] = [];

function openDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

function storage(): McpSecretStorage {
  return new McpSecretStorage({
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`enc:${plain}`),
      decryptString: (payload) => payload.toString('utf8').replace(/^enc:/, ''),
    },
  });
}

describe('MCP repositories', () => {
  afterEach(() => {
    for (const db of dbs.splice(0)) {
      db.close();
    }
  });

  it('stores orchestrator records with encrypted secret env values', () => {
    const db = openDb();
    const repo = new OrchestratorMcpRepository(db, storage());
    const saved = repo.upsert({
      name: 'secret-server',
      scope: 'orchestrator',
      transport: 'stdio',
      command: 'node',
      headers: { Authorization: 'Bearer hunter2', Accept: 'application/json' },
      env: { HOME: '/tmp', API_KEY: 'hunter2' },
    });
    expect(saved.record.env).toEqual({ HOME: '/tmp', API_KEY: 'hunter2' });
    expect(saved.record.headers).toEqual({ Authorization: 'Bearer hunter2', Accept: 'application/json' });
    const row = db.prepare(`
      SELECT headers_json, headers_secrets_encrypted_json, env_json, env_secrets_encrypted_json
      FROM orchestrator_mcp_servers
    `).get<{
      headers_json: string;
      headers_secrets_encrypted_json: string;
      env_json: string;
      env_secrets_encrypted_json: string;
    }>();
    expect(row?.headers_json).toContain('application/json');
    expect(row?.headers_secrets_encrypted_json).not.toContain('hunter2');
    expect(row?.env_json).toContain('/tmp');
    expect(row?.env_secrets_encrypted_json).not.toContain('hunter2');
  });

  it('preserves stored orchestrator env when updating fields from a redacted edit form', () => {
    const db = openDb();
    const repo = new OrchestratorMcpRepository(db, storage());
    const saved = repo.upsert({
      name: 'secret-server',
      scope: 'orchestrator',
      transport: 'stdio',
      command: 'node',
      env: { API_KEY: 'hunter2' },
    });

    repo.upsert({
      id: saved.record.id,
      name: 'renamed-secret-server',
      scope: 'orchestrator',
      transport: 'stdio',
      command: 'node',
      env: { HOME: '/tmp' },
    });

    expect(repo.get(saved.record.id)?.record.env).toEqual({ API_KEY: 'hunter2', HOME: '/tmp' });
  });

  it('persists only orchestrator injection targets that are actually consumed', () => {
    const db = openDb();
    const repo = new OrchestratorMcpRepository(db, storage());
    const saved = repo.upsert({
      name: 'fs',
      scope: 'orchestrator',
      transport: 'stdio',
      command: 'node',
      injectInto: ['claude', 'codex'],
    });

    expect(saved.injectInto).toEqual(['claude']);
  });

  it('upserts and lists shared records', () => {
    const repo = new SharedMcpRepository(openDb(), storage());
    const saved = repo.upsert({
      name: 'fs',
      transport: 'stdio',
      command: 'npx',
      targets: ['claude', 'codex'],
    });
    expect(repo.get(saved.id)?.targets).toEqual(['claude', 'codex']);
    expect(repo.list()[0]?.name).toBe('fs');
  });

  it('preserves stored shared env when updating targets only', () => {
    const repo = new SharedMcpRepository(openDb(), storage());
    const saved = repo.upsert({
      name: 'fs',
      transport: 'stdio',
      command: 'npx',
      env: { API_TOKEN: 'hunter2' },
      targets: ['claude'],
    });

    repo.upsert({
      id: saved.id,
      name: 'fs',
      transport: 'stdio',
      command: 'npx',
      env: { HOME: '/tmp' },
      targets: ['claude', 'codex'],
    });

    expect(repo.get(saved.id)?.env).toEqual({ API_TOKEN: 'hunter2', HOME: '/tmp' });
  });
});
