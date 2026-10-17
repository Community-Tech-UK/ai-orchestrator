import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { listOpenCodeCredentialRepairNames, readOpenCodeV2CredentialNames } from './opencode-credential-names';

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.doUnmock('better-sqlite3');
  vi.resetModules();
});

function fixtureDatabase(extraRows = 0): string {
  const root = mkdtempSync(join(tmpdir(), 'aio-credential-names-'));
  roots.push(root);
  const file = join(root, 'opencode.db');
  const database = new DatabaseSync(file);
  try {
    database.exec('CREATE TABLE credential (integration_id TEXT, active INTEGER, value TEXT)');
    const insert = database.prepare('INSERT INTO credential VALUES (?, ?, ?)');
    database.exec('BEGIN');
    insert.run('aio-mimo-account-b', 1, 'placeholder-not-a-real-key');
    insert.run('xiaomi-token-plan-ams', 1, 'placeholder-not-a-real-key');
    insert.run('inactive', 0, 'placeholder-not-a-real-key');
    for (let index = 0; index < extraRows; index++) insert.run(`fixture-provider-${index}`, 1, 'placeholder-not-a-real-key');
    database.exec('COMMIT');
  } finally { database.close(); }
  return file;
}

it('reads active integration names from disk without exposing values or modifying the database', () => {
  const file = fixtureDatabase();
  const before = readFileSync(file);
  const names = readOpenCodeV2CredentialNames({ OPENCODE_DB: file, XDG_DATA_HOME: '/unselected-data-directory' });
  expect(names).toEqual(['aio-mimo-account-b', 'xiaomi-token-plan-ams']);
  expect(JSON.stringify(names)).not.toContain('placeholder-not-a-real-key');
  expect(readFileSync(file)).toEqual(before);
});

it('never creates a database when the configured path is missing', () => {
  const file = join(dirname(fixtureDatabase()), 'missing.db');
  expect(existsSync(file)).toBe(false);
  expect(readOpenCodeV2CredentialNames({ OPENCODE_DB: file })).toEqual([]);
  expect(existsSync(file)).toBe(false);
});

it('reads account names when the Electron native SQLite binding is unavailable on the worker', async () => {
  const file = fixtureDatabase();
  vi.resetModules();
  vi.doMock('better-sqlite3', () => { throw new Error('Native binding unavailable in standalone worker'); });
  const portable = await import('./opencode-credential-names');
  expect(portable.readOpenCodeV2CredentialNames({ OPENCODE_DB: file })).toEqual(['aio-mimo-account-b', 'xiaomi-token-plan-ams']);
});

it('refuses to treat a truncated names-only query as complete absence', () => {
  const file = fixtureDatabase(1100);
  expect(() => readOpenCodeV2CredentialNames({ OPENCODE_DB: file })).toThrow('Unable to read');
});


it('distinguishes a failed read from an empty store and never offers a legacy repair after that failure', () => {
  const file = fixtureDatabase(); const root = dirname(file); const data = join(root, 'opencode'); mkdirSync(data);
  writeFileSync(join(data, 'auth.json'), JSON.stringify({ 'aio-mimo-account-b': { type: 'api', key: 'placeholder-legacy-key' } }));
  const env = { OPENCODE_DB: file, XDG_DATA_HOME: root };
  expect(listOpenCodeCredentialRepairNames(env)).toEqual([]);
  const lock = new DatabaseSync(file); lock.exec('BEGIN EXCLUSIVE');
  try {
    expect(() => readOpenCodeV2CredentialNames(env)).toThrow('Unable to read');
    expect(listOpenCodeCredentialRepairNames(env)).toBeNull();
  } finally { lock.exec('ROLLBACK'); lock.close(); }
  expect(listOpenCodeCredentialRepairNames(env)).toEqual([]);
});


it('does not offer another legacy copy for an inactive credential already present in the store', () => {
  const file = fixtureDatabase(); const root = dirname(file); mkdirSync(join(root, 'opencode'));
  const database = new DatabaseSync(file);
  database.prepare('INSERT INTO credential VALUES (?, ?, ?)').run('aio-mimo-inactive', 0, 'placeholder-inactive-key'); database.close();
  writeFileSync(join(root, 'opencode', 'auth.json'), JSON.stringify({ 'aio-mimo-inactive': { type: 'api', key: 'placeholder-legacy-key' } }));
  expect(readOpenCodeV2CredentialNames({ OPENCODE_DB: file })).not.toContain('aio-mimo-inactive');
  expect(listOpenCodeCredentialRepairNames({ OPENCODE_DB: file, XDG_DATA_HOME: root })).toEqual([]);
});


it('treats denied database and legacy-file parents as unknown rather than missing', () => {
  const original = fixtureDatabase(); const root = dirname(original); const denied = join(root, 'denied'); mkdirSync(denied);
  const file = join(denied, 'opencode.db'); renameSync(original, file);
  const legacy = join(root, 'opencode'); mkdirSync(legacy);
  writeFileSync(join(legacy, 'auth.json'), JSON.stringify({ 'aio-mimo-account-b': { type: 'api', key: 'placeholder-legacy-key' } }));
  const env = { OPENCODE_DB: file, XDG_DATA_HOME: root };
  chmodSync(denied, 0);
  try { expect(() => readOpenCodeV2CredentialNames(env)).toThrow('Unable to read'); expect(listOpenCodeCredentialRepairNames(env)).toBeNull(); }
  finally { chmodSync(denied, 0o700); }
  chmodSync(legacy, 0);
  try { expect(listOpenCodeCredentialRepairNames(env)).toBeNull(); }
  finally { chmodSync(legacy, 0o700); }
});
