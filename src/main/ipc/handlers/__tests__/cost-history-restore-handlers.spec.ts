import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { IPC_CHANNELS } from '@contracts/channels';
import type { SqliteDriver } from '../../../db/sqlite-driver';
import { defaultDriverFactory } from '../../../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from '../../../persistence/rlm/rlm-schema';
import { repairCostEntriesA0 } from '../../../core/system/cost-entries-a0-repair';
import { CostTracker } from '../../../core/system/cost-tracker';
import type { IpcResponse } from '../../validated-handler';

// LT-707 maintenance IPC must keep the live CostTracker cache in step with the
// rows it rewrites: the tracker serves summaries, history and budgets from an
// in-memory window, so an apply or undo that only mutates the database would
// leave every cost surface serving the pre-action values until restart. These
// tests run the real restore flow against an isolated damaged-history fixture
// and assert the tracker agrees with the database after each action.

const holder = vi.hoisted(() => ({
  db: null as SqliteDriver | null,
  dir: null as string | null,
  tracker: null as CostTracker | null,
}));

vi.mock('../../../core/system/cost-tracker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/system/cost-tracker')>();
  return { ...actual, getCostTracker: () => holder.tracker };
});

vi.mock('../../../persistence/rlm-database', () => ({
  getRLMDatabase: () => ({ getRawDb: () => holder.db }),
}));

vi.mock('../../../core/system/cost-attribution', () => ({
  getCostAttributionDirectory: () => holder.dir,
}));

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload?: unknown) => Promise<IpcResponse>>(),
  handle: vi.fn((channel: string, handler: (event: unknown, payload?: unknown) => Promise<IpcResponse>) => {
    electronMocks.handlers.set(channel, handler);
  }),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: electronMocks.handle },
}));

import { registerCostHistoryRestoreHandlers } from '../cost-history-restore-handlers';
import { CLAUDE_PURPOSE_BOOKING_MARGIN_MS } from '../../../core/system/cost-entries-a0-restore';
import type {
  CostRestoreRollbackSummary,
  CostRestoreSummary,
} from '../../../../shared/types/cost-history-restore.types';

const dbTotal = (db: SqliteDriver): number =>
  db.prepare('SELECT COALESCE(SUM(cost), 0) AS total FROM cost_entries').get<{ total: number }>()?.total ?? -1;

async function invoke(channel: string, payload?: unknown): Promise<IpcResponse> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({}, payload);
}

describe('cost history restore handlers (LT-707)', () => {
  let db: SqliteDriver;
  let dir: string;
  let tracker: CostTracker;
  let claudeCutoff: number;

  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
    dir = mkdtempSync(join(tmpdir(), 'lt707-restore-handlers-'));
    // The first Claude purpose receipt resolves the restore cutoff to just
    // after the cumulative era, so only the per-turn session is in scope. The
    // fixture is now-relative so restored rows also fall inside the budget
    // windows getBudgetStatus() reports.
    const now = Date.now();
    const firstClaudePurposeTs = now - 1_998;
    claudeCutoff = firstClaudePurposeTs - CLAUDE_PURPOSE_BOOKING_MARGIN_MS;
    writeFileSync(
      join(dir, 'cost-attribution-2026-10-01.jsonl'),
      `${JSON.stringify({ source: 'instance-turn', purpose: 'chat', provider: 'claude', ts: firstClaudePurposeTs })}\n`,
    );
    holder.db = db;
    holder.dir = dir;
    tracker = new CostTracker();
    holder.tracker = tracker;
    electronMocks.handlers.clear();
    electronMocks.handle.mockClear();

    // Reproduce the LT-707 damage in isolation: the pre-fix repair treats the
    // per-turn session as cumulative and differences its second row a second
    // time (0.45 → 0.15) while the cumulative-era session is differenced
    // correctly (1.25 → 0.75).
    db.prepare('UPDATE maintenance_markers SET completed_at=? WHERE name=?').run(now + 60_000, 'a0-per-turn-booking-live');
    const row = (id: string, timestamp: number, instance: string, session: string, model: string, cost: number) =>
      db.prepare('INSERT INTO cost_entries (id,timestamp,instance_id,session_id,model,cost) VALUES (?,?,?,?,?,?)')
        .run(id, timestamp, instance, session, model, cost);
    row('cum-a', now - 60_000, 'first', 'cumulative', 'opus', 0.5);
    row('cum-b', now - 50_000, 'first', 'cumulative', 'opus', 1.25);
    row('pt-a', now - 2_500, 'second', 'per-turn', 'sonnet', 0.3);
    row('pt-b', now - 2_000, 'second', 'per-turn', 'sonnet', 0.45);
    repairCostEntriesA0(db, new Map());
    expect(dbTotal(db)).toBeCloseTo(1.7, 10);

    tracker.setDatabase(db);
    registerCostHistoryRestoreHandlers({});
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('apply restores the damaged row and the tracker cache immediately serves the repaired totals', async () => {
    expect(tracker.getSummary().totalCost).toBeCloseTo(dbTotal(db), 10);

    const result = await invoke(IPC_CHANNELS.COST_HISTORY_RESTORE_APPLY);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ status: 'restored', rows: 1 });
    // The summary dollars cover only the changed row (0.15 → 0.45), never the
    // whole checked scope (1.7 → 2).
    const applied = result.data as CostRestoreSummary;
    expect(applied.beforeUsd).toBeCloseTo(0.15, 10);
    expect(applied.afterUsd).toBeCloseTo(0.45, 10);

    expect(dbTotal(db)).toBeCloseTo(2, 10);
    expect(tracker.getSummary().totalCost).toBeCloseTo(dbTotal(db), 10);
    expect(tracker.getEntries().find((entry) => entry.id === 'pt-b')?.cost).toBeCloseTo(0.45, 10);
    expect(tracker.getBudgetStatus().monthly.usage).toBeCloseTo(2, 10);

    // A second apply writes nothing and leaves cache and database agreeing.
    const second = await invoke(IPC_CHANNELS.COST_HISTORY_RESTORE_APPLY);
    expect(second.data).toMatchObject({ status: 'noop', rows: 0 });
    expect(tracker.getSummary().totalCost).toBeCloseTo(dbTotal(db), 10);
  });

  it('undo puts the pre-remediation values back and the tracker cache follows', async () => {
    await invoke(IPC_CHANNELS.COST_HISTORY_RESTORE_APPLY);

    const result = await invoke(IPC_CHANNELS.COST_HISTORY_RESTORE_ROLLBACK);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ status: 'rolled-back', rows: 1 });
    const rolledBack = result.data as CostRestoreRollbackSummary;
    expect(rolledBack.beforeUsd).toBeCloseTo(0.45, 10);
    expect(rolledBack.afterUsd).toBeCloseTo(0.15, 10);

    expect(dbTotal(db)).toBeCloseTo(1.7, 10);
    expect(tracker.getSummary().totalCost).toBeCloseTo(dbTotal(db), 10);
    expect(tracker.getEntries().find((entry) => entry.id === 'pt-b')?.cost).toBeCloseTo(0.15, 10);
  });

  it('status stays read-only and reports the same scope the flow would act on', async () => {
    const result = await invoke(IPC_CHANNELS.COST_HISTORY_RESTORE_STATUS);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      claudeCutoff,
      scopedRows: 2,
      mismatchedRows: 1,
      unverifiedRows: 0,
    });
    expect(dbTotal(db)).toBeCloseTo(1.7, 10);
    expect(tracker.getSummary().totalCost).toBeCloseTo(dbTotal(db), 10);
  });

  it('apply and undo preserve entries whose usage write-through failed (memory-only spend)', async () => {
    // A failed usage INSERT leaves the entry as real recorded spend in memory
    // only (persistEntry retains it). The maintenance reload after apply and
    // undo must serve the repaired rows without erasing that spend, and must
    // never persist it behind the user's back (the reload is read-only).
    db.exec(`CREATE TRIGGER fail_cost_insert BEFORE INSERT ON cost_entries
      BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END`);
    const memoryOnly = tracker.recordUsage('third', 'pending-session', 'claude-sonnet-4-6', 10, 5, 0, 0, 0.05);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM cost_entries WHERE id = ?').get<{ n: number }>(memoryOnly.id)?.n,
    ).toBe(0);
    db.exec('DROP TRIGGER fail_cost_insert');

    const applied = await invoke(IPC_CHANNELS.COST_HISTORY_RESTORE_APPLY);
    expect(applied.success).toBe(true);
    expect(applied.data).toMatchObject({ status: 'restored', rows: 1 });
    expect(dbTotal(db)).toBeCloseTo(2, 10);
    expect(tracker.getEntries().find((entry) => entry.id === memoryOnly.id)?.cost).toBeCloseTo(0.05, 10);
    expect(tracker.getSummary().totalCost).toBeCloseTo(2.05, 10);
    expect(tracker.getBudgetStatus().monthly.usage).toBeCloseTo(2.05, 10);

    const undone = await invoke(IPC_CHANNELS.COST_HISTORY_RESTORE_ROLLBACK);
    expect(undone.success).toBe(true);
    expect(undone.data).toMatchObject({ status: 'rolled-back', rows: 1 });
    expect(dbTotal(db)).toBeCloseTo(1.7, 10);
    expect(tracker.getEntries().find((entry) => entry.id === memoryOnly.id)?.cost).toBeCloseTo(0.05, 10);
    expect(tracker.getSummary().totalCost).toBeCloseTo(1.75, 10);
    // The reload never flushed the memory-only entry into the repaired table.
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM cost_entries WHERE id = ?').get<{ n: number }>(memoryOnly.id)?.n,
    ).toBe(0);
  });
});
