import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../../persistence/rlm/rlm-schema';
import { costProviderKey, repairCostEntriesA0 } from './cost-entries-a0-repair';
import {
  CLAUDE_PURPOSE_BOOKING_MARGIN_MS,
  KNOWN_INSTALL_CLAUDE_PER_TURN_CUTOFF,
  KNOWN_INSTALL_FIRST_CLAUDE_PURPOSE_TS,
  inspectCostEntriesA0Restore,
  inspectStoredCostEntriesA0Restore,
  readA0AttributionEvidence,
  readA0RepairCompletedAt,
  resolveClaudePerTurnCutoff,
  restoreCostEntriesA0Backup,
  restoreStoredCostEntriesA0Backup,
  rollbackCostEntriesA0Restore,
} from './cost-entries-a0-restore';
import { useSqliteTemplate } from '../../db/sqlite-template.test-helpers';

// Isolated LT-707 fixtures: the pre-Phase-A repair (two-argument
// repairCostEntriesA0 with the migration-clock cutoff) reproduces the audited
// damage — valid post-boundary per-turn rows differenced into smaller costs —
// entirely in memory, never against a real database.
describe('LT-707 cost history restoration', () => {
  const rlmTemplate = useSqliteTemplate((db) => {
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
  });
  let db: SqliteDriver;
  const providers = new Map([
    [costProviderKey('reseller', 'claude-opus-5'), 'copilot'],
    [costProviderKey('cursor', 'gpt-6.1-sol'), 'cursor'],
    [costProviderKey('tagged', 'custom-claude-model'), 'claude'],
  ]);
  const row = (id: string, instance: string, session: string, model: string, timestamp: number,
    cost: number, input = 0, output = 0, read = 0, write = 0) => db.prepare(`INSERT INTO cost_entries
      (id,timestamp,instance_id,session_id,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,timestamp,instance,session,model,input,output,read,write,cost);
  const costs = () => db.prepare('SELECT id,cost FROM cost_entries ORDER BY id').all<{id:string;cost:number}>();
  const costOf = (id: string): number | undefined => costs().find(entry => entry.id === id)?.cost;
  const backupRows = () => db.prepare('SELECT id,cost FROM cost_entries_a0_backup ORDER BY id').all<{id:string;cost:number}>();
  const snapshotIds = () => db.prepare('SELECT id FROM cost_entries_a0_restore_backup ORDER BY id').all<{id:string}>().map(entry => entry.id);
  const marker = (name: string): unknown =>
    db.prepare('SELECT name FROM maintenance_markers WHERE name=?').get(name);

  beforeEach(() => {
    db = rlmTemplate.open();
    db.prepare("UPDATE maintenance_markers SET completed_at=1000 WHERE name='a0-per-turn-booking-live'").run();
  });
  afterEach(() => db.close());

  // Cumulative-era session (running totals, correctly differenced), per-turn
  // session inside the protected window, reseller rows, an evidence-tagged
  // non-alias Claude row and a row booked after the repair ran.
  const seedDamagedHistory = (): void => {
    row('cum-a', 'first', 'cumulative', 'opus', 100, 0.5);
    row('cum-b', 'first', 'cumulative', 'opus', 200, 1.25);
    row('cum-c', 'first', 'cumulative', 'opus', 300, 1.5);
    row('pt-a', 'second', 'per-turn', 'sonnet', 600, 0.2);
    row('pt-b', 'second', 'per-turn', 'sonnet', 700, 0.35);
    row('pt-c', 'second', 'per-turn', 'sonnet', 800, 0.4);
    row('tagged-a', 'tagged', 'tagged-session', 'custom-claude-model', 650, 0.5);
    row('tagged-b', 'tagged', 'tagged-session', 'custom-claude-model', 750, 0.8);
    row('res-a', 'reseller', 'reseller-session', 'claude-opus-5', 100, 10, 100, 10, 70, 20);
    row('res-b', 'reseller', 'reseller-session', 'claude-opus-5', 200, 20, 150, 20, 100, 30);
    row('cur-a', 'cursor', 'cursor-session', 'gpt-6.1-sol', 100, 5);
    row('new-a', 'second', 'per-turn', 'sonnet', 2000, 0.3);
    repairCostEntriesA0(db, providers);
  };

  it('reproduces the LT-707 damage and narrowly restores only affected Claude rows', () => {
    seedDamagedHistory();
    // Damage: per-turn rows differenced a second time (0.35 → 0.15, 0.4 → 0.05,
    // 0.8 → 0.3) while the cumulative era keeps its correct deltas.
    expect(costOf('pt-a')).toBe(0.2);
    expect(costOf('pt-b')).toBeCloseTo(0.15, 10);
    expect(costOf('pt-c')).toBeCloseTo(0.05, 10);
    expect(costOf('tagged-a')).toBe(0.5);
    expect(costOf('tagged-b')).toBeCloseTo(0.3, 10);
    expect(costOf('cum-a')).toBe(0.5);
    expect(costOf('cum-b')).toBe(0.75);
    expect(costOf('cum-c')).toBe(0.25);
    expect(backupRows().map(entry => entry.id)).toEqual(
      ['cum-a', 'cum-b', 'cum-c', 'cur-a', 'pt-a', 'pt-b', 'pt-c', 'res-a', 'res-b', 'tagged-a', 'tagged-b']);

    const before = inspectCostEntriesA0Restore(db, providers, 500);
    expect(before.claudeCutoff).toBe(500);
    expect(before.scopedRows).toBe(5);
    expect(before.mismatchedRows).toBe(3);
    expect(before.unverifiedRows).toBe(0);
    // Inspection dollars cover the whole checked scope (0.5+0.35+0.4+0.5+0.8
    // originals, their current values now)…
    expect(before.originalUsd).toBeCloseTo(2.25, 10);
    expect(before.currentUsd).toBeCloseTo(1.2, 10);

    // …while the restore summary covers only the three rows the run changes.
    const summary = restoreCostEntriesA0Backup(db, providers, 500);
    expect(summary.status).toBe('restored');
    expect(summary.rows).toBe(3);
    expect(summary.beforeUsd).toBeCloseTo(0.5, 10);
    expect(summary.afterUsd).toBeCloseTo(1.55, 10);

    // Affected rows equal their originals again.
    expect(costOf('pt-a')).toBe(0.2);
    expect(costOf('pt-b')).toBe(0.35);
    expect(costOf('pt-c')).toBe(0.4);
    expect(costOf('tagged-a')).toBe(0.5);
    expect(costOf('tagged-b')).toBe(0.8);
    // Correctly differenced cumulative rows stay differenced; reseller
    // corrections, unknown rows and newer bookings are untouched.
    expect(costOf('cum-a')).toBe(0.5);
    expect(costOf('cum-b')).toBe(0.75);
    expect(costOf('cum-c')).toBe(0.25);
    const reseller = db.prepare("SELECT id,cost,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens FROM cost_entries WHERE id IN ('res-a','res-b','cur-a') ORDER BY id").all();
    expect(reseller).toEqual([
      {id:'cur-a',cost:0,input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0},
      {id:'res-a',cost:0,input_tokens:10,output_tokens:10,cache_read_tokens:70,cache_write_tokens:20},
      {id:'res-b',cost:0,input_tokens:10,output_tokens:10,cache_read_tokens:30,cache_write_tokens:10},
    ]);
    expect(costOf('new-a')).toBe(0.3);

    // Backup originals are intact and the totals verify.
    expect(backupRows()).toEqual([
      {id:'cum-a',cost:0.5}, {id:'cum-b',cost:1.25}, {id:'cum-c',cost:1.5}, {id:'cur-a',cost:5},
      {id:'pt-a',cost:0.2}, {id:'pt-b',cost:0.35}, {id:'pt-c',cost:0.4},
      {id:'res-a',cost:10}, {id:'res-b',cost:20},
      {id:'tagged-a',cost:0.5}, {id:'tagged-b',cost:0.8},
    ]);
    const after = inspectCostEntriesA0Restore(db, providers, 500);
    expect(after.mismatchedRows).toBe(0);
    expect(after.originalUsd).toBeCloseTo(2.25, 10);
    expect(after.currentUsd).toBeCloseTo(2.25, 10);
    expect(snapshotIds()).toEqual(['pt-b', 'pt-c', 'tagged-b']);
    expect(marker('a0-cost-restore')).toBeDefined();
  });

  it('is idempotent: a second run is a no-op and keeps the first run\'s rollback snapshot', () => {
    seedDamagedHistory();
    const first = restoreCostEntriesA0Backup(db, providers, 500);
    const afterFirst = costs();
    const second = restoreCostEntriesA0Backup(db, providers, 500);
    expect(first.status).toBe('restored');
    expect(second).toEqual({ status: 'noop', rows: 0, beforeUsd: 0, afterUsd: 0 });
    expect(costs()).toEqual(afterFirst);
    expect(snapshotIds()).toEqual(['pt-b', 'pt-c', 'tagged-b']);
  });

  it('rolls back writes, snapshot and marker together on failure, then retries cleanly', () => {
    seedDamagedHistory();
    db.exec(`CREATE TRIGGER abort_restore_marker BEFORE INSERT ON maintenance_markers
      WHEN NEW.name='a0-cost-restore' BEGIN SELECT RAISE(ABORT, 'injected restore failure'); END;`);
    const before = costs();
    const failed = restoreCostEntriesA0Backup(db, providers, 500);
    expect(failed.status).toBe('failed');
    expect(costs()).toEqual(before);
    expect(marker('a0-cost-restore')).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cost_entries_a0_restore_backup'").get()).toBeUndefined();

    db.exec('DROP TRIGGER abort_restore_marker');
    const retried = restoreCostEntriesA0Backup(db, providers, 500);
    expect(retried.status).toBe('restored');
    expect(retried.rows).toBe(3);
    expect(costOf('pt-b')).toBe(0.35);
  });

  it('rolls back the remediation exactly once and then restores again', () => {
    seedDamagedHistory();
    const damaged = costs();
    restoreCostEntriesA0Backup(db, providers, 500);
    expect(costs()).not.toEqual(damaged);

    const rolled = rollbackCostEntriesA0Restore(db);
    expect(rolled.status).toBe('rolled-back');
    expect(rolled.rows).toBe(3);
    expect(costs()).toEqual(damaged);
    expect(snapshotIds()).toEqual([]);
    expect(marker('a0-cost-restore')).toBeUndefined();

    const again = rollbackCostEntriesA0Restore(db);
    expect(again).toEqual({ status: 'noop', rows: 0, beforeUsd: 0, afterUsd: 0 });
    expect(costs()).toEqual(damaged);

    const restored = restoreCostEntriesA0Backup(db, providers, 500);
    expect(restored.status).toBe('restored');
    expect(costOf('pt-c')).toBe(0.4);
  });

  it('treats the cutoff boundary as inclusive and leaves the row below it differenced', () => {
    row('edge-low', 'first', 'edge', 'opus', 498, 0.1);
    row('edge-mid', 'first', 'edge', 'opus', 499, 0.2);
    row('edge-cut', 'first', 'edge', 'opus', 500, 0.3);
    repairCostEntriesA0(db, providers);
    const summary = restoreCostEntriesA0Backup(db, providers, 500);
    expect(summary.rows).toBe(1);
    expect(costOf('edge-low')).toBe(0.1);
    expect(costOf('edge-mid')).toBe(0.1);
    expect(costOf('edge-cut')).toBe(0.3);
  });

  it('reports a missing boundary without writing anything', () => {
    seedDamagedHistory();
    const before = costs();
    expect(restoreStoredCostEntriesA0Backup(db, null)).toEqual(
      { status: 'missing-cutoff', rows: 0, beforeUsd: 0, afterUsd: 0 });
    expect(inspectStoredCostEntriesA0Restore(db, null).claudeCutoff).toBeNull();
    expect(costs()).toEqual(before);
    expect(marker('a0-cost-restore')).toBeUndefined();
  });

  it('resolves the audited install boundary exactly and other installs within the booking margin', () => {
    expect(resolveClaudePerTurnCutoff(KNOWN_INSTALL_FIRST_CLAUDE_PURPOSE_TS)).toBe(KNOWN_INSTALL_CLAUDE_PER_TURN_CUTOFF);
    expect(resolveClaudePerTurnCutoff(KNOWN_INSTALL_FIRST_CLAUDE_PURPOSE_TS + 5000))
      .toBe(KNOWN_INSTALL_FIRST_CLAUDE_PURPOSE_TS + 5000 - CLAUDE_PURPOSE_BOOKING_MARGIN_MS);
    expect(resolveClaudePerTurnCutoff(null)).toBeNull();
    expect(resolveClaudePerTurnCutoff(Number.NaN)).toBeNull();
    expect(resolveClaudePerTurnCutoff(-1)).toBeNull();
    expect(resolveClaudePerTurnCutoff(CLAUDE_PURPOSE_BOOKING_MARGIN_MS)).toBe(0);
  });

  describe('attribution evidence', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lt707-restore-')); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const write = (name: string, lines: string[]): void =>
      writeFileSync(join(dir, name), lines.join('\n') + '\n');

    const boundaryReceipt = (ts = 600_000) =>
      JSON.stringify({ source: 'instance-turn', purpose: 'chat', provider: 'claude', ts });

    const repairCompletedAt = (): number => {
      const repairAt = readA0RepairCompletedAt(db);
      if (repairAt === null) throw new Error('fixture repair marker missing');
      return repairAt;
    };

    it('reads the first Claude purpose receipt and repair-time provider tags, skipping noise', () => {
      write('cost-attribution-2026-10-01.jsonl', [
        JSON.stringify({ source: 'auxiliary', purpose: 'helper', provider: 'claude', ts: 100 }),
        JSON.stringify({ source: 'instance-turn', purpose: 'chat', provider: 'claude-cli', ts: 600_500 }),
        JSON.stringify({ source: 'instance-turn', purpose: 'chat', provider: 'claude', ts: 600_900 }),
        JSON.stringify({ source: 'instance-turn', purpose: 'chat', provider: 'copilot', ts: 601_000 }),
        JSON.stringify({ source: 'instance-turn', taskType: 'loop', provider: 'claude', ts: 602_000 }),
        '{ not json',
      ]);
      write('cost-attribution-2026-10-02.jsonl', [
        JSON.stringify({ instanceId: 'tagged', model: 'custom-claude-model', provider: 'claude-cli', ts: 900 }),
        JSON.stringify({ instanceId: 'reseller', model: 'claude-opus-5', provider: 'copilot', ts: 950 }),
      ]);
      const evidence = readA0AttributionEvidence(dir, 1_000);
      expect(evidence.firstClaudePurposeTs).toBe(600_500);
      expect(evidence.providers.get(costProviderKey('tagged', 'custom-claude-model'))).toBe('claude');
      expect(evidence.providers.get(costProviderKey('reseller', 'claude-opus-5'))).toBe('copilot');
      expect(resolveClaudePerTurnCutoff(evidence.firstClaudePurposeTs)).toBe(600_500 - CLAUDE_PURPOSE_BOOKING_MARGIN_MS);
    });

    it('reports no boundary when no Claude purpose receipt exists', () => {
      write('cost-attribution-2026-10-01.jsonl', [
        JSON.stringify({ instanceId: 'reseller', model: 'claude-opus-5', provider: 'copilot', ts: 950 }),
      ]);
      const evidence = readA0AttributionEvidence(dir, 1_000);
      expect(evidence.firstClaudePurposeTs).toBeNull();
      expect(evidence.providers.size).toBe(1);
      expect(resolveClaudePerTurnCutoff(evidence.firstClaudePurposeTs)).toBeNull();
    });

    it('freezes classification at the repair time: a later receipt cannot reclassify a key', () => {
      write('cost-attribution-2026-10-01.jsonl', [
        JSON.stringify({ instanceId: 'reseller', model: 'claude-opus-5', provider: 'copilot', ts: 500 }),
        JSON.stringify({ instanceId: 'tagged', model: 'custom-claude-model', provider: 'claude', ts: 600 }),
        JSON.stringify({ instanceId: 'reseller', model: 'claude-opus-5', provider: 'claude', ts: 5_000 }),
        JSON.stringify({ instanceId: 'tagged', model: 'custom-claude-model', provider: 'copilot', ts: 5_000 }),
      ]);
      const evidence = readA0AttributionEvidence(dir, 1_000);
      expect(evidence.providers.get(costProviderKey('reseller', 'claude-opus-5'))).toBe('copilot');
      expect(evidence.providers.get(costProviderKey('tagged', 'custom-claude-model'))).toBe('claude');
    });

    it('fails closed on conflicting pre-repair tags and on tags that cannot be placed in time', () => {
      write('cost-attribution-2026-10-01.jsonl', [
        JSON.stringify({ instanceId: 'mixed', model: 'mixed-model', provider: 'copilot', ts: 500 }),
        JSON.stringify({ instanceId: 'mixed', model: 'mixed-model', provider: 'claude', ts: 600 }),
        JSON.stringify({ instanceId: 'unplaceable', model: 'unplaceable-model', provider: 'claude', ts: 500 }),
        JSON.stringify({ instanceId: 'unplaceable', model: 'unplaceable-model', provider: 'copilot' }),
        JSON.stringify({ instanceId: 'agreed', model: 'agreed-model', provider: 'claude', ts: 500 }),
        JSON.stringify({ instanceId: 'agreed', model: 'agreed-model', provider: 'claude' }),
      ]);
      const evidence = readA0AttributionEvidence(dir, 1_000);
      expect(evidence.providers.has(costProviderKey('mixed', 'mixed-model'))).toBe(false);
      expect(evidence.providers.has(costProviderKey('unplaceable', 'unplaceable-model'))).toBe(false);
      expect(evidence.providers.get(costProviderKey('agreed', 'agreed-model'))).toBe('claude');
    });

    it('freezes nothing when the repair time is unknown', () => {
      write('cost-attribution-2026-10-01.jsonl', [
        JSON.stringify({ instanceId: 'tagged', model: 'custom-claude-model', provider: 'claude', ts: 500 }),
      ]);
      expect(readA0AttributionEvidence(dir, null).providers.size).toBe(0);
      expect(readA0AttributionEvidence(dir, Number.NaN).providers.size).toBe(0);
    });

    it('restores through the maintenance entry point using frozen evidence', () => {
      write('cost-attribution-2026-10-01.jsonl', [
        boundaryReceipt(600_500),
        JSON.stringify({ instanceId: 'second', model: 'sonnet', provider: 'claude', ts: 600_000 }),
      ]);
      row('cum-a', 'first', 'cumulative', 'opus', 100_000, 0.5);
      row('cum-b', 'first', 'cumulative', 'opus', 200_000, 1.25);
      row('pt-a', 'second', 'per-turn', 'sonnet', 600_450, 0.3);
      row('pt-b', 'second', 'per-turn', 'sonnet', 600_600, 0.45);
      db.prepare("UPDATE maintenance_markers SET completed_at=700_000 WHERE name='a0-per-turn-booking-live'").run();
      repairCostEntriesA0(db, providers);
      expect(costOf('pt-b')).toBeCloseTo(0.15, 10);

      const summary = restoreStoredCostEntriesA0Backup(db, dir);
      expect(summary.status).toBe('restored');
      expect(summary.rows).toBe(1);
      expect(costOf('pt-a')).toBe(0.3);
      expect(costOf('pt-b')).toBe(0.45);
      expect(costOf('cum-a')).toBe(0.5);
      expect(costOf('cum-b')).toBe(0.75);
    });

    // The repair's Copilot branch rewrites rows to cost 0 with differenced
    // tokens; provider switches preserve instance ids, so a receipt written
    // after the repair must never reclassify those rows into restore scope.
    it('never rewrites reseller corrections on a post-repair provider switch', () => {
      write('cost-attribution-2026-10-01.jsonl', [
        boundaryReceipt(600_000),
        JSON.stringify({ instanceId: 'reseller', model: 'claude-opus-5', provider: 'copilot', ts: 600_100 }),
      ]);
      row('res-a', 'reseller', 'reseller-session', 'claude-opus-5', 600_500, 10, 100, 10, 70, 20);
      row('res-b', 'reseller', 'reseller-session', 'claude-opus-5', 600_700, 20, 150, 20, 100, 30);
      db.prepare("UPDATE maintenance_markers SET completed_at=700_000 WHERE name='a0-per-turn-booking-live'").run();
      repairCostEntriesA0(db, providers);
      const repaired = db.prepare('SELECT * FROM cost_entries ORDER BY id').all();
      expect(costOf('res-a')).toBe(0);
      expect(costOf('res-b')).toBe(0);

      appendFileSync(join(dir, 'cost-attribution-2026-10-01.jsonl'),
        JSON.stringify({ instanceId: 'reseller', model: 'claude-opus-5', provider: 'claude',
          ts: repairCompletedAt() + 1 }) + '\n');

      const summary = restoreStoredCostEntriesA0Backup(db, dir);
      expect(summary).toEqual({ status: 'noop', rows: 0, beforeUsd: 0, afterUsd: 0 });
      expect(db.prepare('SELECT * FROM cost_entries ORDER BY id').all()).toEqual(repaired);
      const inspection = inspectStoredCostEntriesA0Restore(db, dir);
      expect(inspection.scopedRows).toBe(0);
      expect(inspection.mismatchedRows).toBe(0);
      expect(inspection.unverifiedRows).toBe(0);
    });

    it('still restores Claude rows when a post-repair receipt switches their provider', () => {
      write('cost-attribution-2026-10-01.jsonl', [
        boundaryReceipt(600_000),
        JSON.stringify({ instanceId: 'tagged', model: 'custom-claude-model', provider: 'claude', ts: 600_100 }),
      ]);
      row('tagged-a', 'tagged', 'tagged-session', 'custom-claude-model', 600_500, 0.5);
      row('tagged-b', 'tagged', 'tagged-session', 'custom-claude-model', 600_700, 0.8);
      db.prepare("UPDATE maintenance_markers SET completed_at=700_000 WHERE name='a0-per-turn-booking-live'").run();
      repairCostEntriesA0(db, providers);
      expect(costOf('tagged-b')).toBeCloseTo(0.3, 10);

      appendFileSync(join(dir, 'cost-attribution-2026-10-01.jsonl'),
        JSON.stringify({ instanceId: 'tagged', model: 'custom-claude-model', provider: 'copilot',
          ts: repairCompletedAt() + 1 }) + '\n');

      const summary = restoreStoredCostEntriesA0Backup(db, dir);
      expect(summary.status).toBe('restored');
      expect(summary.rows).toBe(1);
      expect(costOf('tagged-a')).toBe(0.5);
      expect(costOf('tagged-b')).toBe(0.8);
    });

    it('fails closed on ambiguous classification: conflicting pre-repair tags are never written', () => {
      write('cost-attribution-2026-10-01.jsonl', [
        boundaryReceipt(600_000),
        JSON.stringify({ instanceId: 'reseller', model: 'claude-opus-5', provider: 'copilot', ts: 600_100 }),
        JSON.stringify({ instanceId: 'reseller', model: 'claude-opus-5', provider: 'claude', ts: 600_200 }),
      ]);
      row('conf-a', 'reseller', 'reseller-session', 'claude-opus-5', 600_500, 10, 100, 10, 70, 20);
      row('conf-b', 'reseller', 'reseller-session', 'claude-opus-5', 600_700, 20, 150, 20, 100, 30);
      db.prepare("UPDATE maintenance_markers SET completed_at=700_000 WHERE name='a0-per-turn-booking-live'").run();
      // The repair's last tag was Claude, so its Claude branch differenced conf-b.
      repairCostEntriesA0(db, new Map([[costProviderKey('reseller', 'claude-opus-5'), 'claude']]));
      expect(costOf('conf-b')).toBe(10);
      const damaged = db.prepare('SELECT * FROM cost_entries ORDER BY id').all();

      const summary = restoreStoredCostEntriesA0Backup(db, dir);
      expect(summary).toEqual({ status: 'noop', rows: 0, beforeUsd: 0, afterUsd: 0 });
      expect(db.prepare('SELECT * FROM cost_entries ORDER BY id').all()).toEqual(damaged);
      const inspection = inspectStoredCostEntriesA0Restore(db, dir);
      expect(inspection.scopedRows).toBe(0);
      expect(inspection.unverifiedRows).toBe(2);
    });

    it('fails closed when a tag cannot be placed in time against the repair', () => {
      write('cost-attribution-2026-10-01.jsonl', [
        boundaryReceipt(600_000),
        JSON.stringify({ instanceId: 'tagged', model: 'custom-claude-model', provider: 'claude', ts: 600_100 }),
        JSON.stringify({ instanceId: 'tagged', model: 'custom-claude-model', provider: 'copilot' }),
      ]);
      row('tagged-a', 'tagged', 'tagged-session', 'custom-claude-model', 600_500, 0.5);
      row('tagged-b', 'tagged', 'tagged-session', 'custom-claude-model', 600_700, 0.8);
      db.prepare("UPDATE maintenance_markers SET completed_at=700_000 WHERE name='a0-per-turn-booking-live'").run();
      repairCostEntriesA0(db, providers);
      const damaged = db.prepare('SELECT * FROM cost_entries ORDER BY id').all();

      const summary = restoreStoredCostEntriesA0Backup(db, dir);
      expect(summary).toEqual({ status: 'noop', rows: 0, beforeUsd: 0, afterUsd: 0 });
      expect(db.prepare('SELECT * FROM cost_entries ORDER BY id').all()).toEqual(damaged);
      expect(inspectStoredCostEntriesA0Restore(db, dir).unverifiedRows).toBe(2);
    });

    it('fails closed on evidence keys without the repair marker while alias rows still restore', () => {
      write('cost-attribution-2026-10-01.jsonl', [
        boundaryReceipt(600_000),
        JSON.stringify({ instanceId: 'tagged', model: 'custom-claude-model', provider: 'claude', ts: 600_100 }),
      ]);
      row('pt-a', 'second', 'per-turn', 'sonnet', 600_500, 0.3);
      row('pt-b', 'second', 'per-turn', 'sonnet', 600_700, 0.45);
      row('tagged-a', 'tagged', 'tagged-session', 'custom-claude-model', 600_400, 0.5);
      row('tagged-b', 'tagged', 'tagged-session', 'custom-claude-model', 600_600, 0.8);
      db.prepare("UPDATE maintenance_markers SET completed_at=700_000 WHERE name='a0-per-turn-booking-live'").run();
      repairCostEntriesA0(db, providers);
      expect(costOf('pt-b')).toBeCloseTo(0.15, 10);
      expect(costOf('tagged-b')).toBeCloseTo(0.3, 10);
      db.prepare("DELETE FROM maintenance_markers WHERE name='a0-cost-deltas'").run();

      const summary = restoreStoredCostEntriesA0Backup(db, dir);
      expect(summary.status).toBe('restored');
      expect(summary.rows).toBe(1);
      expect(costOf('pt-a')).toBe(0.3);
      expect(costOf('pt-b')).toBe(0.45);
      expect(costOf('tagged-b')).toBeCloseTo(0.3, 10);
      const inspection = inspectStoredCostEntriesA0Restore(db, dir);
      expect(inspection.scopedRows).toBe(2);
      expect(inspection.unverifiedRows).toBe(2);
    });
  });
});
