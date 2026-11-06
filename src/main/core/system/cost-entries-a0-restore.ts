/**
 * LT-707 existing-history restoration.
 *
 * The A0 history repair (`cost-entries-a0-repair.ts`) differenced Claude rows
 * booked before migration 077's own clock. Claude per-turn booking was already
 * live earlier (17 Oct 2026 08:31:19 BST on the audited install), so valid
 * per-turn rows were differenced a second time and their recorded costs
 * shrank. `cost_entries_a0_backup` still holds every processed row's
 * original values.
 *
 * This module restores only the wrongly repaired Claude rows from those
 * originals. It is an explicit application maintenance flow: it is never run
 * at startup and never runs without a user action. Copilot/Cursor ("reseller")
 * corrections, correctly differenced pre-boundary rows and rows booked after
 * the repair are all left untouched. Non-alias rows are classified with
 * provider evidence frozen at the repair's own completion time, and rows whose
 * classification cannot be verified fail closed and are never written. Writes,
 * the rollback snapshot and the marker are one transaction; re-running is a
 * no-op.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { SqliteDriver } from '../../db/sqlite-driver';
import type {
  CostRestoreInspection,
  CostRestoreRollbackSummary,
  CostRestoreSummary,
} from '../../../shared/types/cost-history-restore.types';
import { getLogger } from '../../logging/logger';
import { getCostAttributionDirectory } from './cost-attribution';
import { costProviderKey } from './cost-entries-a0-repair';

const logger = getLogger('CostEntriesA0Restore');

/** Kept in sync with `CLAUDE_ALIASES` in cost-entries-a0-repair.ts. */
const CLAUDE_ALIASES = new Set(['opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku', 'fable', 'fable[1m]']);

/**
 * Per-turn boundary evidence (LT-707). The audited install started per-turn
 * Claude booking at the 17 Oct 2026 08:31:19 BST restart (07:31:19 UTC) =
 * epoch 1792222279000; its first purpose receipt landed 2 ms after the first
 * booked row (`_scratch/oct2-audit/_verify-3.md` S1, register LT-707). The
 * prevention repair resolves the same boundary inside
 * `repairStoredCostEntriesA0`; keep both rules identical until they share one
 * helper. `recordCompletionCost` books the row before appending its purpose
 * receipt, so other installs allow only the short booking/receipt gap below.
 */
export const CLAUDE_PURPOSE_BOOKING_MARGIN_MS = 1000;
export const KNOWN_INSTALL_FIRST_CLAUDE_PURPOSE_TS = 1792223492775;
export const KNOWN_INSTALL_CLAUDE_PER_TURN_CUTOFF = 1792222279000;

const RESTORE_MARKER = 'a0-cost-restore';
const RESTORE_BACKUP_TABLE = 'cost_entries_a0_restore_backup';
const A0_BACKUP_TABLE = 'cost_entries_a0_backup';
const REPAIR_MARKER = 'a0-cost-deltas';

interface A0AttributionEvidence {
  /**
   * Repair-time provider tags, frozen at the `a0-cost-deltas` completion time.
   * A key is present only when its historical classification is unambiguous;
   * keys that cannot be frozen are absent, so their rows fail closed.
   */
  providers: Map<string, string>;
  firstClaudePurposeTs: number | null;
}

interface JoinedRow {
  id: string;
  timestamp: number;
  instance_id: string;
  model: string;
  original_cost: number;
  original_input_tokens: number;
  original_output_tokens: number;
  original_cache_read_tokens: number;
  original_cache_write_tokens: number;
  current_cost: number;
  current_input_tokens: number;
  current_output_tokens: number;
  current_cache_read_tokens: number;
  current_cache_write_tokens: number;
}

interface SnapshotRow {
  id: string;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

const emptyRestore = (status: CostRestoreSummary['status']): CostRestoreSummary =>
  ({ status, rows: 0, beforeUsd: 0, afterUsd: 0 });
const emptyRollback = (status: CostRestoreRollbackSummary['status']): CostRestoreRollbackSummary =>
  ({ status, rows: 0, beforeUsd: 0, afterUsd: 0 });

const tableExists = (db: SqliteDriver, name: string): boolean =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;

/**
 * Resolve the install's Claude per-turn boundary from its first purpose
 * receipt. The audited install is recognised by its recorded first receipt and
 * keeps its documented start so bookings before that receipt are covered too.
 */
export function resolveClaudePerTurnCutoff(firstClaudePurposeTs: number | null): number | null {
  if (firstClaudePurposeTs === null || !Number.isFinite(firstClaudePurposeTs) || firstClaudePurposeTs < 0) {
    return null;
  }
  if (firstClaudePurposeTs === KNOWN_INSTALL_FIRST_CLAUDE_PURPOSE_TS) {
    return KNOWN_INSTALL_CLAUDE_PER_TURN_CUTOFF;
  }
  return Math.max(0, firstClaudePurposeTs - CLAUDE_PURPOSE_BOOKING_MARGIN_MS);
}

const addTag = (bucket: Map<string, Set<string>>, key: string, value: string): void => {
  const values = bucket.get(key);
  if (values) values.add(value);
  else bucket.set(key, new Set([value]));
};

/**
 * Read the first Claude purpose receipt and the repair-time provider tags from
 * attribution JSONL. Provider classification is frozen at `repairCompletedAt`
 * (the `a0-cost-deltas` marker): a tag only counts when its record can be
 * placed at or before the repair, because that is the evidence the repair
 * classified with. Records written after the repair cannot change history and
 * are ignored, so a later provider switch on the same (instance, model) can
 * never reclassify rows the repair already wrote. A key fails closed — it is
 * left out of `providers` and its rows are never restored — when its pre-repair
 * tags conflict, when its tags cannot be placed in time (missing timestamps, or
 * no repair marker to freeze against), or when a placed tag disagrees with an
 * unplaceable one. The first Claude purpose receipt is deliberately not
 * bounded: it resolves when per-turn booking started, and only an earlier
 * receipt can lower the minimum.
 */
export function readA0AttributionEvidence(
  dir: string | null | undefined,
  repairCompletedAt: number | null,
): A0AttributionEvidence {
  const providers = new Map<string, string>();
  let firstClaudePurposeTs: number | null = null;
  const freezeBound = repairCompletedAt !== null && Number.isFinite(repairCompletedAt) && repairCompletedAt >= 0
    ? repairCompletedAt
    : null;
  const placed = new Map<string, Set<string>>();
  const unplaced = new Map<string, Set<string>>();
  if (dir && existsSync(dir)) {
    for (const file of readdirSync(dir).filter(file => /^cost-attribution-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort()) {
      for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          if (record['source'] === 'instance-turn' && typeof record['purpose'] === 'string'
            && (record['provider'] === 'claude' || record['provider'] === 'claude-cli')
            && typeof record['ts'] === 'number' && Number.isFinite(record['ts']) && record['ts'] >= 0) {
            firstClaudePurposeTs = firstClaudePurposeTs === null ? record['ts'] : Math.min(firstClaudePurposeTs, record['ts']);
          }
          if (typeof record['instanceId'] === 'string' && typeof record['model'] === 'string' && typeof record['provider'] === 'string') {
            const key = costProviderKey(record['instanceId'], record['model']);
            const value = record['provider'].replace(/-cli$/, '');
            const ts = record['ts'];
            if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0) addTag(unplaced, key, value);
            else if (freezeBound === null) addTag(unplaced, key, value);
            else if (ts <= freezeBound) addTag(placed, key, value);
            /* else: written after the repair — not historical classification */
          }
        } catch { /* incomplete log lines are not provider evidence */ }
      }
    }
  }
  for (const key of new Set([...placed.keys(), ...unplaced.keys()])) {
    const repairTimeTags = placed.get(key) ?? new Set<string>();
    const allTags = new Set([...repairTimeTags, ...(unplaced.get(key) ?? [])]);
    if (repairTimeTags.size === 1 && allTags.size === 1) providers.set(key, [...repairTimeTags][0]);
  }
  return { providers, firstClaudePurposeTs };
}

/** When the `a0-cost-deltas` repair committed, or null when it cannot be proven. */
export function readA0RepairCompletedAt(db: SqliteDriver): number | null {
  try {
    const row = db.prepare('SELECT completed_at FROM maintenance_markers WHERE name=?')
      .get<{ completed_at: number }>(REPAIR_MARKER);
    return row && Number.isFinite(row.completed_at) && row.completed_at >= 0 ? row.completed_at : null;
  } catch {
    return null;
  }
}

const selectJoinedRows = (db: SqliteDriver, claudeCutoff: number): JoinedRow[] =>
  db.prepare(`SELECT b.id AS id, b.timestamp AS timestamp, b.instance_id AS instance_id, b.model AS model,
      b.cost AS original_cost, b.input_tokens AS original_input_tokens, b.output_tokens AS original_output_tokens,
      b.cache_read_tokens AS original_cache_read_tokens, b.cache_write_tokens AS original_cache_write_tokens,
      c.cost AS current_cost, c.input_tokens AS current_input_tokens, c.output_tokens AS current_output_tokens,
      c.cache_read_tokens AS current_cache_read_tokens, c.cache_write_tokens AS current_cache_write_tokens
    FROM ${A0_BACKUP_TABLE} b JOIN cost_entries c ON c.id = b.id
    WHERE b.timestamp >= ?
    ORDER BY b.timestamp, b.rowid`).all<JoinedRow>(claudeCutoff);

/**
 * Only the rows the repair's Claude branch rewrote are remediation scope.
 * Alias models classify directly (the repair's own rule); other models use the
 * repair-time provider tags `readA0AttributionEvidence` froze, so reseller rows
 * keep their corrections. A key missing from the map — conflicting or
 * unplaceable evidence — fails closed and is never written.
 */
const inRestoreScope = (row: JoinedRow, providers: ReadonlyMap<string, string>): boolean =>
  (CLAUDE_ALIASES.has(row.model) ? 'claude' : providers.get(costProviderKey(row.instance_id, row.model))) === 'claude';

/** Rows whose repair-time classification cannot be verified and therefore fail closed. */
const isUnverified = (row: JoinedRow, providers: ReadonlyMap<string, string>): boolean =>
  !CLAUDE_ALIASES.has(row.model) && !providers.has(costProviderKey(row.instance_id, row.model));

const isAltered = (row: JoinedRow): boolean =>
  row.current_cost !== row.original_cost
  || row.current_input_tokens !== row.original_input_tokens
  || row.current_output_tokens !== row.original_output_tokens
  || row.current_cache_read_tokens !== row.original_cache_read_tokens
  || row.current_cache_write_tokens !== row.original_cache_write_tokens;

/**
 * Read-only before/after totals for the rows the remediation may restore.
 * `originalUsd`/`currentUsd` sum the whole checked scope; the restore summary
 * sums only the rows a run actually changes. `unverifiedRows` counts rows whose
 * classification fails closed and which no run will ever write.
 */
export function inspectCostEntriesA0Restore(
  db: SqliteDriver,
  providers: ReadonlyMap<string, string>,
  claudeCutoff: number,
): CostRestoreInspection {
  const rows = tableExists(db, A0_BACKUP_TABLE) ? selectJoinedRows(db, claudeCutoff) : [];
  let scopedRows = 0;
  let mismatchedRows = 0;
  let unverifiedRows = 0;
  let originalUsd = 0;
  let currentUsd = 0;
  for (const row of rows) {
    if (inRestoreScope(row, providers)) {
      scopedRows += 1;
      if (isAltered(row)) mismatchedRows += 1;
      originalUsd += row.original_cost;
      currentUsd += row.current_cost;
    } else if (isUnverified(row, providers)) {
      unverifiedRows += 1;
    }
  }
  return { claudeCutoff, scopedRows, mismatchedRows, originalUsd, currentUsd, unverifiedRows };
}

/**
 * Restore the repair-written fields of every affected Claude row from
 * `cost_entries_a0_backup`. The pre-remediation values of the rows being
 * written are snapshotted first so `rollbackCostEntriesA0Restore` can undo the
 * run; a snapshot row from an earlier run is kept as-is, so undo always
 * returns the pre-remediation state. Snapshot, writes and marker commit or
 * roll back together; a second run over restored rows finds no mismatches and
 * writes nothing.
 */
export function restoreCostEntriesA0Backup(
  db: SqliteDriver,
  providers: ReadonlyMap<string, string>,
  claudeCutoff: number,
): CostRestoreSummary {
  const summary = emptyRestore('noop');
  try {
    if (!Number.isFinite(claudeCutoff) || claudeCutoff < 0) throw new Error('Invalid Claude per-turn cutoff');
    if (!tableExists(db, A0_BACKUP_TABLE)) return summary;
    const rows = selectJoinedRows(db, claudeCutoff);
    const affected = rows.filter(row => inRestoreScope(row, providers) && isAltered(row));
    if (affected.length === 0) return summary;
    summary.status = 'restored';
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS ${RESTORE_BACKUP_TABLE} AS SELECT * FROM cost_entries WHERE 0`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${RESTORE_BACKUP_TABLE}_id ON ${RESTORE_BACKUP_TABLE}(id)`);
      const snapshot = db.prepare(`INSERT OR IGNORE INTO ${RESTORE_BACKUP_TABLE} SELECT * FROM cost_entries WHERE id=?`);
      const update = db.prepare('UPDATE cost_entries SET cost=?, input_tokens=?, output_tokens=?, cache_read_tokens=?, cache_write_tokens=? WHERE id=?');
      for (const row of affected) {
        snapshot.run(row.id);
        update.run(row.original_cost, row.original_input_tokens, row.original_output_tokens,
          row.original_cache_read_tokens, row.original_cache_write_tokens, row.id);
        summary.rows += 1;
        summary.beforeUsd += row.current_cost;
        summary.afterUsd += row.original_cost;
      }
      db.prepare('INSERT OR REPLACE INTO maintenance_markers(name, completed_at) VALUES (?, ?)').run(RESTORE_MARKER, Date.now());
    })();
    logger.info('LT-707 cost history restoration complete', {
      ...summary,
      claudeCutoff,
      unverifiedRows: rows.filter(row => isUnverified(row, providers)).length,
    });
    return summary;
  } catch (error) {
    logger.warn('LT-707 cost history restoration rolled back', { error: String(error) });
    return emptyRestore('failed');
  }
}

/**
 * Undo a restoration: put back the snapshotted pre-remediation values and
 * clear the snapshot and marker. With no snapshot the database is already in
 * the pre-remediation state and nothing is written.
 */
export function rollbackCostEntriesA0Restore(db: SqliteDriver): CostRestoreRollbackSummary {
  const summary = emptyRollback('noop');
  try {
    if (!tableExists(db, RESTORE_BACKUP_TABLE)) return summary;
    const snapshotRows = db.prepare(`SELECT id, cost, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
      FROM ${RESTORE_BACKUP_TABLE} ORDER BY timestamp, rowid`).all<SnapshotRow>();
    if (snapshotRows.length === 0) return summary;
    summary.status = 'rolled-back';
    db.transaction(() => {
      const current = db.prepare('SELECT cost FROM cost_entries WHERE id=?');
      const update = db.prepare('UPDATE cost_entries SET cost=?, input_tokens=?, output_tokens=?, cache_read_tokens=?, cache_write_tokens=? WHERE id=?');
      for (const row of snapshotRows) {
        const live = current.get<{ cost: number }>(row.id);
        if (!live) continue;
        update.run(row.cost, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens, row.id);
        summary.rows += 1;
        summary.beforeUsd += live.cost;
        summary.afterUsd += row.cost;
      }
      db.prepare(`DELETE FROM ${RESTORE_BACKUP_TABLE}`).run();
      db.prepare('DELETE FROM maintenance_markers WHERE name=?').run(RESTORE_MARKER);
    })();
    logger.info('LT-707 cost history restoration rolled back', { ...summary });
    return summary;
  } catch (error) {
    logger.warn('LT-707 cost history rollback failed', { error: String(error) });
    return emptyRollback('failed');
  }
}

/** Maintenance-flow entry points: freeze the repair's evidence, resolve this install's boundary, then act. */
export function inspectStoredCostEntriesA0Restore(
  db: SqliteDriver,
  dir: string | null | undefined = getCostAttributionDirectory(),
): CostRestoreInspection {
  const { providers, firstClaudePurposeTs } = readA0AttributionEvidence(dir, readA0RepairCompletedAt(db));
  const claudeCutoff = resolveClaudePerTurnCutoff(firstClaudePurposeTs);
  if (claudeCutoff === null) {
    return { claudeCutoff: null, scopedRows: 0, mismatchedRows: 0, originalUsd: 0, currentUsd: 0, unverifiedRows: 0 };
  }
  return inspectCostEntriesA0Restore(db, providers, claudeCutoff);
}

export function restoreStoredCostEntriesA0Backup(
  db: SqliteDriver,
  dir: string | null | undefined = getCostAttributionDirectory(),
): CostRestoreSummary {
  try {
    const { providers, firstClaudePurposeTs } = readA0AttributionEvidence(dir, readA0RepairCompletedAt(db));
    const claudeCutoff = resolveClaudePerTurnCutoff(firstClaudePurposeTs);
    if (claudeCutoff === null) {
      logger.warn('LT-707 cost history restoration skipped: Claude per-turn boundary unavailable');
      return emptyRestore('missing-cutoff');
    }
    return restoreCostEntriesA0Backup(db, providers, claudeCutoff);
  } catch (error) {
    logger.warn('LT-707 cost history restoration deferred: attribution evidence unavailable', { error: String(error) });
    return emptyRestore('failed');
  }
}
