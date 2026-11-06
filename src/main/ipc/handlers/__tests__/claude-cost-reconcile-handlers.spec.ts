import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { IPC_CHANNELS } from '@contracts/channels';
import { defaultDriverFactory } from '../../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../../../persistence/rlm/rlm-schema';
import { ClaudeCostReconcileService, getClaudeCostReconcileService } from '../../../core/system/claude-cost-reconcile-service';
import { _resetForTesting as resetCleanupRegistry, runCleanupFunctions } from '../../../util/cleanup-registry';

const holder = vi.hoisted(() => ({
  handlers: new Map<string, () => Promise<{ success: boolean; data?: unknown; error?: { code: string } }>>(),
  userData: '',
  db: null as unknown,
  dbFails: false,
}));
vi.mock('electron', () => ({
  app: { getPath: () => holder.userData },
  ipcMain: { handle: (channel: string, fn: () => Promise<never>) => { holder.handlers.set(channel, fn); } },
}));
vi.mock('../../../persistence/rlm-database', () => ({
  getRLMDatabase: () => {
    if (holder.dbFails) throw new Error('database unavailable');
    return { getRawDb: () => holder.db };
  },
}));
vi.mock('../../../cli/adapters/account-pool/provider-account-home-resolver', () => ({ CLAUDE_PROFILES_ROOT_DIR: 'claude-cli-profiles' }));

import { registerClaudeCostReconcileHandlers } from '../claude-cost-reconcile-handlers';

describe('Claude cost check IPC', () => {
  let db: SqliteDriver;
  beforeEach(() => {
    holder.handlers.clear();
    holder.dbFails = false;
    holder.userData = mkdtempSync(join(tmpdir(), 'aio-reconcile-ipc-'));
    db = defaultDriverFactory(':memory:'); createTables(db); createMigrationsTable(db); runMigrations(db);
    holder.db = db;
    ClaudeCostReconcileService._resetForTesting();
    resetCleanupRegistry();
  });
  afterEach(() => {
    ClaudeCostReconcileService._resetForTesting();
    resetCleanupRegistry();
    db.close();
    rmSync(holder.userData, { recursive: true, force: true });
  });

  it('registers both channels and answers GET with the empty snapshot before any check', async () => {
    registerClaudeCostReconcileHandlers();
    expect([...holder.handlers.keys()].sort()).toEqual(['claude-cost-reconcile:get', 'claude-cost-reconcile:run']);
    expect(IPC_CHANNELS.CLAUDE_COST_RECONCILE_GET).toBe('claude-cost-reconcile:get');
    const reply = await holder.handlers.get(IPC_CHANNELS.CLAUDE_COST_RECONCILE_GET)!();
    expect(reply).toEqual({ success: true, data: { latest: null, history: [], running: false, lastError: null } });
  });

  it('RUN checks real stored rows against a real transcript and returns the report', async () => {
    // An empty home, so the only transcript found is the one under the account profile.
    vi.stubEnv('HOME', join(holder.userData, 'home'));
    mkdirSync(join(holder.userData, 'claude-cli-profiles', 'work', 'projects', 'p'), { recursive: true });
    writeFileSync(join(holder.userData, 'claude-cli-profiles', 'work', 'projects', 'p', 'sess-1.jsonl'),
      '{"type":"assistant"}\n{"type":"cost-state","totalCostUSD":10,"hasUnknownModelCost":false}\n');
    const now = Date.now();
    db.prepare('INSERT INTO cost_entries (id,timestamp,instance_id,session_id,model,cost) VALUES (?,?,?,?,?,?)').run('1', now - 1000, 'i', 'sess-1', 'opus', 12);
    registerClaudeCostReconcileHandlers();
    const reply = await holder.handlers.get(IPC_CHANNELS.CLAUDE_COST_RECONCILE_RUN)!();
    expect(reply.success).toBe(true);
    expect(reply.data).toMatchObject({
      running: false, lastError: null,
      latest: { status: 'drift', coverage: { compared: 1 }, total: { storedUsd: 12, cliUsd: 10 } },
    });
    vi.unstubAllEnvs();
  });

  it('still registers the channels, and reports an empty snapshot, when the database cannot be opened', async () => {
    holder.dbFails = true;
    registerClaudeCostReconcileHandlers();
    expect(holder.handlers.size).toBe(2);
    expect(await holder.handlers.get(IPC_CHANNELS.CLAUDE_COST_RECONCILE_RUN)!()).toMatchObject({ success: true, data: { latest: null } });
  });

  it('stops the schedule and discards any running check when the app shuts down', async () => {
    const shutdown = vi.spyOn(getClaudeCostReconcileService(), 'shutdown');
    registerClaudeCostReconcileHandlers();
    expect(shutdown).not.toHaveBeenCalled();
    await runCleanupFunctions();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(await getClaudeCostReconcileService().runNow()).toBeNull();
  });

  it('starts the daily schedule when it registers', () => {
    const start = vi.spyOn(getClaudeCostReconcileService(), 'start');
    registerClaudeCostReconcileHandlers();
    expect(start).toHaveBeenCalledTimes(1);
  });
});
