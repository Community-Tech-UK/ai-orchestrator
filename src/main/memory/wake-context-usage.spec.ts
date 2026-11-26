import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { recordCompactionMarker } from '../persistence/rlm/rlm-compaction-markers';
import { recordWakeHintShowing } from '../persistence/rlm/rlm-wake-hint-history';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';

const state = vi.hoisted(() => ({
  db: null as SqliteDriver | null,
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>(),
}));
vi.mock('../persistence/rlm-database', () => ({
  getRLMDatabase: () => ({ getRawDb: () => state.db }),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => state.handlers.set(channel, handler) },
}));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { getWakeContextBuilder, WakeContextBuilder } from './wake-context-builder';
import { registerWakeContextHandlers } from '../ipc/handlers/wake-context-handlers';
import { recoverCompactionContext } from '../app/compaction-recovery';
import type { InstanceManager } from '../instance/instance-manager';

describe('wake hints shown at session start', () => {
  let db: SqliteDriver;
  let hintId: string;
  beforeEach(() => {
    WakeContextBuilder._resetForTesting();
    state.handlers.clear();
    db = defaultDriverFactory(':memory:');
    state.db = db;
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
    hintId = getWakeContextBuilder().addHint('Project background.', { room: 'general' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    WakeContextBuilder._resetForTesting();
    db.close();
    state.db = null;
  });
  const usage = () => getWakeContextBuilder().getHint(hintId)?.usageCount;

  it('counts every new session even when the rendered context is cached', () => {
    const builder = getWakeContextBuilder();
    const first = builder.getWakeUpText('/repo');
    const second = builder.getWakeUpText('/repo');
    expect(second).toBe(first);
    expect(usage()).toBe(2);
  });

  it('omits externally deleted notes from a cached new start and counts the surviving note', () => {
    const builder = getWakeContextBuilder();
    const survivingId = builder.addHint('Still relevant project background.', { room: 'general' });
    const first = builder.getWakeUpText('/repo');
    expect(first).toContain('Project background.');
    expect(first).toContain('Still relevant project background.');

    // Another process owns note removal, so this builder never receives its cache invalidation.
    db.prepare('DELETE FROM wake_hints WHERE id = ?').run(hintId);
    const nextStart = builder.getWakeUpText('/repo');

    expect(nextStart).not.toContain('Project background.');
    expect(nextStart).toContain('Still relevant project background.');
    expect(builder.getHint(survivingId)?.usageCount).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS total FROM wake_hint_showings WHERE hint_id = ?')
      .get<{ total: number }>(survivingId)?.total).toBe(2);
  });

  it('records surviving showing IDs atomically when a deleted ID reaches the history writer', () => {
    const survivingId = getWakeContextBuilder().addHint('Still relevant.', { room: 'general' });
    db.pragma('foreign_keys = ON');
    db.prepare('DELETE FROM wake_hints WHERE id = ?').run(hintId);

    expect(() => recordWakeHintShowing(db, [hintId, survivingId], 'start-after-delete', Date.now())).not.toThrow();
    expect(db.prepare('SELECT hint_id FROM wake_hint_showings WHERE showing_id = ?')
      .all<{ hint_id: string }>('start-after-delete')).toEqual([{ hint_id: survivingId }]);
    expect(getWakeContextBuilder().getHint(survivingId)?.usageCount).toBe(1);
  });

  it('keeps explicit rebuilds read-only, including last-used time', () => {
    const builder = getWakeContextBuilder();
    const before = builder.getHint(hintId);
    builder.getWakeUpText('/repo', { bypassCache: true, recordUsage: false });
    builder.getWakeUpText('/repo', { bypassCache: true, recordUsage: false });
    expect(builder.getHint(hintId)).toEqual(before);
  });

  it('counts only hints actually rendered within the budget', () => {
    const omittedId = getWakeContextBuilder().addHint('Omitted background.', { importance: 1 });
    getWakeContextBuilder().configure({ l1MaxHints: 1 });
    const text = getWakeContextBuilder().getWakeUpText();
    expect(text).toContain('Project background.');
    expect(text).not.toContain('Omitted background.');
    expect(usage()).toBe(1);
    expect(getWakeContextBuilder().getHint(omittedId)?.usageCount).toBe(0);
  });

  it('does not count empty or whitespace-only notes as shown', () => {
    const empty = getWakeContextBuilder().addHint('   \n  ', { importance: 10 });
    getWakeContextBuilder().getWakeUpText('/repo');
    expect(getWakeContextBuilder().getHint(empty)?.usageCount).toBe(0);
  });

  it('returns rolling persisted showing facts through the real list IPC', async () => {
    const clock = vi.spyOn(Date, 'now');
    const now = Date.now();
    const day = 86_400_000;
    clock.mockReturnValue(now - 31 * day);
    getWakeContextBuilder().getWakeUpText('/repo');
    clock.mockReturnValue(now - 2 * day);
    getWakeContextBuilder().getWakeUpText('/repo');
    clock.mockReturnValue(now);
    // A fresh builder must read persisted history rather than an in-memory count.
    WakeContextBuilder._resetForTesting();
    registerWakeContextHandlers();
    const response = await state.handlers.get(IPC_CHANNELS.WAKE_LIST_HINTS)!({}, {}) as {
      data: { id: string; review?: { shownIn30Days: number } }[];
    };
    expect(response.data.find((hint) => hint.id === hintId)?.review?.shownIn30Days).toBe(1);
    clock.mockRestore();
  });

  it('does not count IPC previews or rebuilds before a cached new-session build', async () => {
    registerWakeContextHandlers();
    await state.handlers.get(IPC_CHANNELS.WAKE_GENERATE)!({}, { wing: '/repo' });
    await state.handlers.get(IPC_CHANNELS.WAKE_GET_TEXT)!({}, { wing: '/repo' });
    expect(usage()).toBe(0);
    getWakeContextBuilder().getWakeUpText('/repo');
    expect(usage()).toBe(1);
  });

  it('restores wake text after compaction without counting another session', async () => {
    recordCompactionMarker(db, { id: 'marker', instanceId: 'instance', projectKey: '/repo', method: 'self-managed', createdAt: 200 });
    const queued: string[] = [];
    const instanceManager = {
      getInstance: () => ({ id: 'instance', status: 'idle', workingDirectory: '/repo' }),
      queueContinuityPreamble: (_id: string, text: string) => queued.push(text),
    } as unknown as Pick<InstanceManager, 'getInstance' | 'queueContinuityPreamble'>;
    await recoverCompactionContext({ instanceId: 'instance', markerId: 'marker' }, { db, instanceManager });
    expect(queued[0]).toContain('Project background.');
    expect(usage()).toBe(0);
  });
});
