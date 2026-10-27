import type { SqliteDriver } from '../db/sqlite-driver';
import type { EncryptedSecret, McpSecretStorage } from '../mcp/secret-storage';

export interface GraphAccount {
  accountKey: string;
  username: string;
  tenant: string;
  createdAt: number;
  updatedAt: number;
  [key: string]: unknown;
}

export interface GraphAccountInput {
  accountKey: string;
  username: string;
  tenant: string;
  tokenCache: string;
  scopes?: readonly string[];
}

interface GraphAccountRow {
  account_key: string;
  username: string;
  tenant: string;
  token_cache_encrypted_json: string;
  scopes_json: string;
  created_at: number;
  updated_at: number;
}

export class GraphTokenStore {
  constructor(
    private readonly db: SqliteDriver,
    private readonly secrets: McpSecretStorage,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_accounts (
        account_key TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        tenant TEXT NOT NULL,
        token_cache_encrypted_json TEXT NOT NULL,
        scopes_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const columns = this.db.prepare('PRAGMA table_info(graph_accounts)').all<{ name: string }>();
    if (!columns.some((column) => column.name === 'scopes_json')) {
      this.db.exec("ALTER TABLE graph_accounts ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '[]'");
    }
  }

  getAccount(accountKey: string): GraphAccount | null {
    const row = this.db
      .prepare('SELECT * FROM graph_accounts WHERE account_key = ?')
      .get<GraphAccountRow>(accountKey);
    return row ? this.toAccount(row) : null;
  }

  listAccounts(): GraphAccount[] {
    return this.db
      .prepare('SELECT * FROM graph_accounts ORDER BY username COLLATE NOCASE ASC')
      .all<GraphAccountRow>()
      .map((row) => this.toAccount(row));
  }

  getTokenCache(accountKey: string): string | null {
    const row = this.db
      .prepare(
        'SELECT token_cache_encrypted_json FROM graph_accounts WHERE account_key = ?',
      )
      .get<Pick<GraphAccountRow, 'token_cache_encrypted_json'>>(accountKey);
    if (!row) {
      return null;
    }
    const encrypted = parseEncryptedCache(row.token_cache_encrypted_json);
    return this.secrets.decryptSecret(encrypted);
  }

  getScopes(accountKey: string): string[] {
    const row = this.db.prepare('SELECT scopes_json FROM graph_accounts WHERE account_key = ?')
      .get<{ scopes_json: string }>(accountKey);
    if (!row) return [];
    const scopes: unknown = JSON.parse(row.scopes_json);
    if (!Array.isArray(scopes) || !scopes.every((scope): scope is string => typeof scope === 'string')) {
      throw new Error('GRAPH_SCOPES_INVALID: stored Microsoft account scopes are malformed');
    }
    return scopes;
  }

  upsertAccount(input: GraphAccountInput): GraphAccount {
    const now = this.now();
    const encryptedCache = this.secrets.encryptSecret(input.tokenCache);
    this.db
      .prepare(`
        INSERT INTO graph_accounts (
          account_key, username, tenant, token_cache_encrypted_json, scopes_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_key) DO UPDATE SET
          username = excluded.username,
          tenant = excluded.tenant,
          token_cache_encrypted_json = excluded.token_cache_encrypted_json,
          scopes_json = excluded.scopes_json,
          updated_at = excluded.updated_at
      `)
      .run(
        input.accountKey,
        input.username,
        input.tenant,
        JSON.stringify(encryptedCache),
        JSON.stringify(input.scopes ?? this.getScopes(input.accountKey)),
        now,
        now,
      );
    return this.getAccount(input.accountKey)!;
  }

  removeAccount(accountKey: string): boolean {
    return (
      this.db.prepare('DELETE FROM graph_accounts WHERE account_key = ?').run(accountKey)
        .changes > 0
    );
  }

  updateTokenCache(accountKey: string, tokenCache: string): boolean {
    if (!this.getAccount(accountKey)) {
      return false;
    }
    const encryptedCache = this.secrets.encryptSecret(tokenCache);
    return (
      this.db
        .prepare(`
          UPDATE graph_accounts
          SET token_cache_encrypted_json = ?, updated_at = ?
          WHERE account_key = ?
        `)
        .run(JSON.stringify(encryptedCache), this.now(), accountKey).changes > 0
    );
  }

  private toAccount(row: GraphAccountRow): GraphAccount {
    return {
      accountKey: row.account_key,
      username: row.username,
      tenant: row.tenant,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function parseEncryptedCache(value: string): EncryptedSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('GRAPH_TOKEN_CACHE_INVALID: encrypted cache record is malformed');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('status' in parsed) ||
    parsed.status !== 'encrypted' ||
    !('payload' in parsed) ||
    typeof parsed.payload !== 'string' ||
    parsed.payload.length === 0
  ) {
    throw new Error('GRAPH_TOKEN_CACHE_INVALID: encrypted cache record is required');
  }
  return { status: 'encrypted', payload: parsed.payload };
}
