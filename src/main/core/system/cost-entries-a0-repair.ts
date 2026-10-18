import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { getLogger } from '../../logging/logger';
import { getCostAttributionDirectory } from './cost-attribution';

const logger = getLogger('CostEntriesA0Repair');
const CLAUDE_ALIASES = new Set(['opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku', 'fable', 'fable[1m]']);
interface RepairRow {
  id: string; timestamp: number; instance_id: string; session_id: string; model: string; cost: number;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
}
export interface CostRepairSummary { status: 'repaired' | 'already-repaired' | 'missing-cutoff' | 'failed'; rows: number; beforeUsd: number; afterUsd: number; }
export function costProviderKey(instanceId: string, model: string): string { return JSON.stringify([instanceId, model]); }

/** Deterministic repair over supplied provider evidence. Backup, writes and marker are atomic. */
export function repairCostEntriesA0(db: SqliteDriver, providers: ReadonlyMap<string, string>): CostRepairSummary {
  const result = (status: CostRepairSummary['status']): CostRepairSummary => ({ status, rows: 0, beforeUsd: 0, afterUsd: 0 });
  try {
    if (db.prepare('SELECT completed_at FROM maintenance_markers WHERE name=?').get('a0-cost-deltas')) return result('already-repaired');
    const cutoff = db.prepare('SELECT completed_at FROM maintenance_markers WHERE name=?').get<{completed_at:number}>('a0-per-turn-booking-live');
    if (!cutoff || !Number.isFinite(cutoff.completed_at)) {
      logger.warn('A0 cost repair skipped: per-turn booking cutoff missing');
      return result('missing-cutoff');
    }
    const rows = db.prepare('SELECT * FROM cost_entries WHERE timestamp < ? ORDER BY timestamp, rowid').all<RepairRow>(cutoff.completed_at);
    const summary = result('repaired');
    db.transaction(() => {
      const claudeTotals = new Map<string, number>();
      const copilotTotals = new Map<string, RepairRow>();
      const backup = db.prepare('INSERT INTO cost_entries_a0_backup SELECT * FROM cost_entries WHERE id=?');
      const update = db.prepare('UPDATE cost_entries SET cost=?, input_tokens=?, output_tokens=?, cache_read_tokens=?, cache_write_tokens=? WHERE id=?');
      for (const row of rows) {
        const provider = CLAUDE_ALIASES.has(row.model) ? 'claude' : providers.get(costProviderKey(row.instance_id, row.model));
        if (provider !== 'claude' && provider !== 'copilot' && provider !== 'cursor') continue;
        backup.run(row.id);
        let cost = 0;
        let input = row.input_tokens;
        let output = row.output_tokens;
        let read = row.cache_read_tokens;
        let write = row.cache_write_tokens;
        // Missing native ids must never chain unrelated sessions together.
        const session = row.session_id || row.instance_id;
        if (provider === 'claude') {
          const previous = claudeTotals.get(session) ?? 0;
          cost = row.cost >= previous ? row.cost - previous : Math.max(0, row.cost);
          claudeTotals.set(session, Math.max(0, row.cost));
        } else if (provider === 'copilot') {
          const previous = copilotTotals.get(session);
          const keys = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'] as const;
          const reset = !previous || keys.some(key => row[key] < previous[key]);
          const delta = (key: typeof keys[number]): number => Math.max(0, row[key] - (reset ? 0 : previous![key]));
          read = delta('cache_read_tokens'); write = delta('cache_write_tokens'); output = delta('output_tokens');
          input = Math.max(0, delta('input_tokens') - read - write);
          copilotTotals.set(session, row);
        }
        update.run(cost, input, output, read, write, row.id);
        summary.rows += 1; summary.beforeUsd += row.cost; summary.afterUsd += cost;
      }
      db.prepare('INSERT INTO maintenance_markers(name, completed_at) VALUES (?, ?)').run('a0-cost-deltas', Date.now());
    })();
    logger.info('A0 historical cost repair complete', { ...summary, cutoff: cutoff.completed_at });
    return summary;
  } catch (error) {
    logger.warn('A0 cost repair rolled back; retrying at next startup', { error: String(error) });
    return result('failed');
  }
}

/** Startup adapter: recover provider tags by (instance, model), never instance alone. */
export function repairStoredCostEntriesA0(db: SqliteDriver): CostRepairSummary {
  try {
    const dir = getCostAttributionDirectory();
    const providers = new Map<string, string>();
    if (dir && existsSync(dir)) {
      for (const file of readdirSync(dir).filter(file => /^cost-attribution-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort()) {
        for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
          try {
            const record = JSON.parse(line) as Record<string, unknown>;
            if (typeof record['instanceId'] === 'string' && typeof record['model'] === 'string' && typeof record['provider'] === 'string') {
              providers.set(costProviderKey(record['instanceId'], record['model']), record['provider'].replace(/-cli$/, ''));
            }
          } catch { /* incomplete log lines are not provider evidence */ }
        }
      }
    }
    return repairCostEntriesA0(db, providers);
  } catch (error) {
    logger.warn('A0 provider evidence unavailable; historical repair deferred to next startup', { error: String(error) });
    return { status: 'failed', rows: 0, beforeUsd: 0, afterUsd: 0 };
  }
}
