import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { OrchestratorMcpRepository } from './orchestrator-mcp-repository';
import { McpSecretStorage } from './secret-storage';

const databases: SqliteDriver[] = [];
const secrets = new McpSecretStorage({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value.split('').reverse().join('')),
    decryptString: (value) => value.toString().split('').reverse().join(''),
  },
});
function setup() {
  const db = defaultDriverFactory(':memory:');
  databases.push(db);
  return { db, repo: new OrchestratorMcpRepository(db, secrets) };
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));
describe('connector persistence', () => {
  it('persists account metadata and Gemini/Cursor injection choices', () => {
    const { repo } = setup();
    const saved = repo.upsert({
      name: 'm365-example',
      kind: 'microsoft365',
      accountId: 'example',
      mailEnabled: true,
      injectInto: ['gemini', 'cursor'],
    });
    expect(repo.get(saved.record.id)).toMatchObject({
      record: { kind: 'microsoft365', accountId: 'example', mailEnabled: true },
      injectInto: ['gemini', 'cursor'],
    });
  });
  it('rejects ambiguous or reserved names on save', () => {
    const { repo } = setup();
    repo.upsert({ name: 'example', command: 'node' });
    for (const name of [
      'example',
      'EXAMPLE',
      'browser-gateway',
      'chrome-devtools',
      'mobile-mcp',
      'maestro',
      'orchestrator',
      'bad name',
      'bad_name',
      'a'.repeat(65),
    ]) {
      expect(() => repo.upsert({ name, command: 'node' })).toThrow();
    }
  });
  it('migrates Shared once without resurrecting deleted connectors or modifying old rows', () => {
    const { db } = setup();
    db.prepare(
      `INSERT INTO shared_mcp_servers (id,name,transport,command,targets_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
    ).run('shared-example', 'shared-example', 'stdio', 'node', '["claude","gemini"]', 1, 1);
    // Simulate an upgrade before migration has run.
    db.exec('DELETE FROM connector_migration_state');
    const repo = new OrchestratorMcpRepository(db, secrets);
    expect(repo.list().map((entry) => entry.record.name)).toEqual(['shared-example']);
    repo.delete(repo.list()[0].record.id);
    expect(new OrchestratorMcpRepository(db, secrets).list()).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM shared_mcp_servers').get()).toEqual({ n: 1 });
  });
});
