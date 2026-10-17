import { DatabaseSync } from 'node:sqlite';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function missing(file: string): boolean {
  try { statSync(file); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}

/** Read identifiers only; never select the credential value column or trigger migrations. */
export function readOpenCodeV2CredentialNames(env: NodeJS.ProcessEnv = process.env, includeInactive = false): string[] {
  const file = env['OPENCODE_DB']?.trim() || join(env['XDG_DATA_HOME']?.trim() || join(homedir(), '.local', 'share'), 'opencode', 'opencode.db');
  let database: DatabaseSync | undefined;
  try {
    if (missing(file)) return [];
    database = new DatabaseSync(file, { readOnly: true, timeout: 1000, allowExtension: false });
    const rows = database.prepare(`SELECT DISTINCT integration_id FROM credential ${includeInactive ? '' : 'WHERE active = 1'} LIMIT 1025`).all() as { integration_id: string }[];
    if (rows.length > 1024) throw new Error('Credential names exceed the safe read limit');
    return rows.flatMap((row) => typeof row.integration_id === 'string' && row.integration_id.length <= 256 ? [row.integration_id] : []);
  } catch { throw new Error('Unable to read OpenCode 2 credential names. Retry after the store is available.'); }
  finally { database?.close(); }
}

/** Names that were not carried into v2. Account sign-in offers an explicit copy. */
export function listOpenCodeCredentialRepairNames(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const file = join(env['XDG_DATA_HOME']?.trim() || join(homedir(), '.local', 'share'), 'opencode', 'auth.json');
  try {
    if (missing(file)) return [];
    if (statSync(file).size > 256 * 1024) return null;
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const current = new Set(readOpenCodeV2CredentialNames(env, true));
    return Object.keys(parsed).filter((name) => /^(?:aio-mimo-[a-z0-9][a-z0-9-]*|xiaomi-token-plan-(?:ams|sgp|cn))$/.test(name) && !current.has(name)).sort();
  } catch { return null; }
}
