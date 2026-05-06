import type { SqliteDriver } from '../db/sqlite-driver';
import type { EncryptedSecret, McpSecretStorage } from './secret-storage';
import { SecretClassifier } from './secret-classifier';

export interface SecretRecordStorageParts {
  publicJson: string | null;
  secretsJson: string | null;
}

export function stringifyJson(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  return JSON.stringify(value);
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function splitSecretRecordForStorage(
  record: Record<string, string> | undefined,
  secrets: McpSecretStorage,
  classifier = new SecretClassifier(),
): SecretRecordStorageParts {
  if (!record || Object.keys(record).length === 0) {
    return { publicJson: null, secretsJson: null };
  }
  const plain: Record<string, string> = {};
  const encrypted: Record<string, EncryptedSecret> = {};
  for (const [key, value] of Object.entries(record)) {
    if (classifier.isSecret(key, value)) {
      encrypted[key] = secrets.encryptSecret(value);
    } else {
      plain[key] = value;
    }
  }
  return {
    publicJson: Object.keys(plain).length > 0 ? JSON.stringify(plain) : null,
    secretsJson: Object.keys(encrypted).length > 0 ? JSON.stringify(encrypted) : null,
  };
}

export function hydrateSecretRecordFromStorage(
  publicJson: string | null | undefined,
  secretsJson: string | null | undefined,
  secrets: McpSecretStorage,
): Record<string, string> | undefined {
  const plain = parseJson<Record<string, string>>(publicJson, {});
  const encrypted = parseJson<Record<string, EncryptedSecret>>(secretsJson, {});
  const record: Record<string, string> = { ...plain };
  for (const [key, secret] of Object.entries(encrypted)) {
    record[key] = secrets.decryptSecret(secret);
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

export const splitEnvForStorage = splitSecretRecordForStorage;
export const hydrateEnvFromStorage = hydrateSecretRecordFromStorage;

export function ensureMcpTables(db: SqliteDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orchestrator_mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      scope TEXT NOT NULL CHECK (scope IN ('orchestrator','orchestrator-bootstrap','orchestrator-codemem')),
      transport TEXT NOT NULL CHECK (transport IN ('stdio','sse','http')),
      command TEXT,
      args_json TEXT,
      url TEXT,
      headers_json TEXT,
      headers_secrets_encrypted_json TEXT,
      env_json TEXT,
      env_secrets_encrypted_json TEXT,
      auto_connect INTEGER NOT NULL DEFAULT 0 CHECK (auto_connect IN (0,1)),
      inject_into_json TEXT NOT NULL DEFAULT '["claude","codex","gemini","copilot"]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shared_mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      transport TEXT NOT NULL CHECK (transport IN ('stdio','sse','http')),
      command TEXT,
      args_json TEXT,
      url TEXT,
      headers_json TEXT,
      headers_secrets_encrypted_json TEXT,
      env_json TEXT,
      env_secrets_encrypted_json TEXT,
      targets_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  ensureColumn(
    db,
    'orchestrator_mcp_servers',
    'headers_secrets_encrypted_json',
    'headers_secrets_encrypted_json TEXT',
  );
  ensureColumn(
    db,
    'shared_mcp_servers',
    'headers_secrets_encrypted_json',
    'headers_secrets_encrypted_json TEXT',
  );
}

function ensureColumn(db: SqliteDriver, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}
