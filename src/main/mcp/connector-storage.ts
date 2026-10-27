import { CONNECTOR_STORAGE_SQL } from '../persistence/rlm/rlm-migrations-076-080';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getLogger } from '../logging/logger';

const RESERVED_NAMES = new Set([
  'browser-gateway',
  'chrome-devtools',
  'mobile-mcp',
  'maestro',
  'orchestrator',
  'codemem',
  'computer-use',
]);
export function assertConnectorName(name: string): void {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(name)) {
    throw new Error('Use 1 to 64 letters, numbers, or hyphens for the connector name.');
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    throw new Error('That name is used by a built-in tool server. Choose another connector name.');
  }
}

export function ensureConnectorStorage(db: SqliteDriver): void {
  const columns = db.prepare('PRAGMA table_info(orchestrator_mcp_servers)').all<{ name: string }>();
  if (!columns.some((c) => c.name === 'connector_json'))
    db.exec('ALTER TABLE orchestrator_mcp_servers ADD COLUMN connector_json TEXT');
  db.exec(CONNECTOR_STORAGE_SQL);
}

/** Copy stored ciphertext unchanged; never rewrite the AI tools' own files. */
export function migrateSharedConnectors(db: SqliteDriver): void {
  const logger = getLogger('ConnectorMigration');
  db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT * FROM shared_mcp_servers WHERE id NOT IN (SELECT source_id FROM connector_migration_state)`,
      )
      .all<{ id: string; name: string }>();
    for (const row of rows) {
      let reason: string | undefined;
      try {
        assertConnectorName(row.name);
      } catch (error) {
        reason = (error as Error).message;
      }
      if (!reason) {
        if (
          db
            .prepare(
              'SELECT id FROM orchestrator_mcp_servers WHERE name = ? COLLATE NOCASE OR id = ?',
            )
            .get(row.name, row.id)
        ) {
          reason = 'A connector already uses this name or identifier.';
        }
      }
      if (!reason) {
        db.prepare(
          `INSERT INTO orchestrator_mcp_servers
          (id,name,description,scope,transport,command,args_json,url,headers_json,headers_secrets_encrypted_json,
           env_json,env_secrets_encrypted_json,auto_connect,inject_into_json,created_at,updated_at)
          SELECT id,name,description,'orchestrator',transport,command,args_json,url,headers_json,headers_secrets_encrypted_json,
           env_json,env_secrets_encrypted_json,1,targets_json,created_at,updated_at FROM shared_mcp_servers WHERE id = ?`,
        ).run(row.id);
      } else {
        logger.warn('Shared tool server was not converted to a connector', {
          name: row.name,
          reason,
        });
      }
      db.prepare('INSERT INTO connector_migration_state(source_id) VALUES (?)').run(row.id);
    }
  })();
}
