import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { getLogger } from '../../logging/logger';
import { getCostAttributionDirectory } from './cost-attribution';

const logger = getLogger('CostEntriesA0Repair');
const CLAUDE_ALIASES = new Set(['opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku', 'fable', 'fable[1m]']);
// recordCompletionCost books the row before appending its purpose receipt.
// The audited first pair is 2 ms apart (LT-707). Bound this ordering allowance
// to one second so generic installs do not exempt broad cumulative history.
const CLAUDE_PURPOSE_BOOKING_MARGIN_MS = 1000;
// 17 Oct 2026 08:31:19 BST: when per-turn booking first ran on the audited install (plan Step 1).
const INSTALL_PER_TURN_START_MS = 1792222279000;
interface RepairRow {
  id: string; timestamp: number; instance_id: string; session_id: string; model: string; cost: number;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
}
export interface CostRepairSummary { status: 'repaired' | 'already-repaired' | 'missing-cutoff' | 'failed'; rows: number; beforeUsd: number; afterUsd: number; }
export function costProviderKey(instanceId: string, model: string): string { return JSON.stringify([instanceId, model]); }

/** Deterministic repair over supplied provider evidence. Backup, writes and marker are atomic. */
export function repairCostEntriesA0(
  db: SqliteDriver, providers: ReadonlyMap<string, string>, claudePerTurnBookingAt?: number,
): CostRepairSummary {
  const result = (status: CostRepairSummary['status']): CostRepairSummary => ({ status, rows: 0, beforeUsd: 0, afterUsd: 0 });
  try {
    if (db.prepare('SELECT completed_at FROM maintenance_markers WHERE name=?').get('a0-cost-deltas')) return result('already-repaired');
    const cutoff = db.prepare('SELECT completed_at FROM maintenance_markers WHERE name=?').get<{completed_at:number}>('a0-per-turn-booking-live');
    if (!cutoff || !Number.isFinite(cutoff.completed_at)) {
      logger.warn('A0 cost repair skipped: per-turn booking cutoff missing');
      return result('missing-cutoff');
    }
    const claudeCutoff = Math.min(cutoff.completed_at, claudePerTurnBookingAt ?? cutoff.completed_at);
    if (!Number.isFinite(claudeCutoff)) throw new Error('Invalid Claude per-turn cutoff');
    const rows = db.prepare('SELECT * FROM cost_entries WHERE timestamp < ? ORDER BY timestamp, rowid').all<RepairRow>(cutoff.completed_at);
    const summary = result('repaired');
    db.transaction(() => {
      const claudeTotals = new Map<string, number>();
      const copilotTotals = new Map<string, RepairRow>();
      // Migration 077's backup has a fixed shape; later live columns (origin,
      // for example) must not change the historical backup copy.
      const backup = db.prepare(`INSERT INTO cost_entries_a0_backup
        (id, timestamp, instance_id, session_id, model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, reasoning_tokens, cost, is_estimated)
        SELECT id, timestamp, instance_id, session_id, model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, reasoning_tokens, cost, is_estimated
        FROM cost_entries WHERE id=?`);
      const update = db.prepare('UPDATE cost_entries SET cost=?, input_tokens=?, output_tokens=?, cache_read_tokens=?, cache_write_tokens=? WHERE id=?');
      for (const row of rows) {
        const provider = CLAUDE_ALIASES.has(row.model) ? 'claude' : providers.get(costProviderKey(row.instance_id, row.model));
        if (provider === 'claude' && row.timestamp >= claudeCutoff) continue;
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
    logger.info('A0 historical cost repair complete', { ...summary, cutoff: cutoff.completed_at, claudeCutoff });
    return summary;
  } catch (error) {
    logger.warn('A0 cost repair rolled back; retrying at next startup', { error: String(error) });
    return result('failed');
  }
}

/** Startup adapter: recover provider tags by (instance, model), never instance alone. */
export function repairStoredCostEntriesA0(db: SqliteDriver): CostRepairSummary {
  try {
    if (db.prepare('SELECT completed_at FROM maintenance_markers WHERE name=?').get('a0-cost-deltas')) {
      return { status: 'already-repaired', rows: 0, beforeUsd: 0, afterUsd: 0 };
    }
    const dir = getCostAttributionDirectory();
    let firstClaudePurpose = Infinity;
    const providers = new Map<string, string>();
    if (dir && existsSync(dir)) {
      for (const file of readdirSync(dir).filter(file => /^cost-attribution-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort()) {
        for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
          try {
            const record = JSON.parse(line) as Record<string, unknown>;
            if (record['source'] === 'instance-turn' && typeof record['purpose'] === 'string'
              && (record['provider'] === 'claude' || record['provider'] === 'claude-cli')
              && typeof record['ts'] === 'number' && Number.isFinite(record['ts']) && record['ts'] >= 0) {
              firstClaudePurpose = Math.min(firstClaudePurpose, record['ts']);
            }
            if (typeof record['instanceId'] === 'string' && typeof record['model'] === 'string' && typeof record['provider'] === 'string') {
              providers.set(costProviderKey(record['instanceId'], record['model']), record['provider'].replace(/-cli$/, ''));
            }
          } catch { /* incomplete log lines are not provider evidence */ }
        }
      }
    }
    // This install's audited start was 17 Oct 08:31:19 BST (07:31:19Z),
    // epoch 1792222279000: root _scratch/oct2-audit/_verify-3.md S1 and
    // claude_oct-2-todo.md K1. Its first purpose record arrived later, so
    // use the start to also protect bookings before that first log record.
    // Fingerprint only this known evidence; other installs keep their own
    // first Claude purpose record, allowing only its short booking/receipt gap.
    // Never modify migration 077.
    // Plan Step 1 last resort: with no Claude purpose record at all, use that documented start rather than
    // deferring on every launch. repairCostEntriesA0 still takes the earlier of it and the migration marker.
    const noEvidence = !Number.isFinite(firstClaudePurpose);
    const knownInstallRecord = firstClaudePurpose === 1792223492775;
    const claudeCutoff = noEvidence || knownInstallRecord ? INSTALL_PER_TURN_START_MS : Math.max(0, firstClaudePurpose - CLAUDE_PURPOSE_BOOKING_MARGIN_MS);
    logger.info('A0 Claude per-turn cutoff resolved', {
      claudeCutoff, source: noEvidence ? 'documented-constant-no-purpose-record' : knownInstallRecord ? 'documented-installed-start' : 'first-claude-purpose-with-booking-margin',
    });
    return repairCostEntriesA0(db, providers, claudeCutoff);
  } catch (error) {
    logger.warn('A0 provider evidence unavailable; historical repair deferred to next startup', { error: String(error) });
    return { status: 'failed', rows: 0, beforeUsd: 0, afterUsd: 0 };
  }
}
