import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { InstanceManager } from '../instance/instance-manager';
import {
  createMigrationsTable,
  createTables,
  runMigrations,
} from '../persistence/rlm/rlm-schema';
import { recordCompactionMarker } from '../persistence/rlm/rlm-compaction-markers';
import { addSegment } from '../persistence/rlm/rlm-verbatim';
import { recoverCompactionContext } from './compaction-recovery';

const dbs: SqliteDriver[] = [];

function openMigratedDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

function buildManager(status = 'idle'): Pick<InstanceManager, 'getInstance' | 'queueContinuityPreamble'> {
  return {
    getInstance: vi.fn(() => ({
      id: 'inst-1',
      status,
      workingDirectory: '/repo',
      provider: 'codex',
    })),
    queueContinuityPreamble: vi.fn(),
  } as unknown as Pick<InstanceManager, 'getInstance' | 'queueContinuityPreamble'>;
}

describe('compaction recovery', () => {
  afterEach(() => {
    for (const db of dbs.splice(0)) {
      db.close();
    }
  });

  it('queues bounded wake context and pre-marker verbatim segments into the next turn', async () => {
    const db = openMigratedDb();
    recordCompactionMarker(db, {
      id: 'marker-1',
      instanceId: 'inst-1',
      threadId: 'thread-1',
      projectKey: '/repo',
      method: 'self-managed',
      createdAt: 200,
      ledgerAnchor: 150,
      metadata: { source: 'provider-thread-compacted' },
    });
    addSegment(db, {
      id: 'before',
      content: 'Important pre-compaction transcript detail.',
      sourceFile: 'session.jsonl',
      chunkIndex: 1,
      wing: '/repo',
      room: 'general',
      importance: 10,
    });
    db.prepare('UPDATE verbatim_segments SET created_at = ? WHERE id = ?').run(140, 'before');
    addSegment(db, {
      id: 'after',
      content: 'Detail recorded after compaction and must not be injected.',
      sourceFile: 'session.jsonl',
      chunkIndex: 2,
      wing: '/repo',
      room: 'general',
      importance: 20,
    });
    db.prepare('UPDATE verbatim_segments SET created_at = ? WHERE id = ?').run(160, 'after');

    const manager = buildManager();
    const result = await recoverCompactionContext({
      instanceId: 'inst-1',
      markerId: 'marker-1',
    }, {
      db,
      instanceManager: manager,
      getWakeText: () => 'Wake context for this project.',
      now: () => 300,
    });

    expect(result).toMatchObject({
      markerId: 'marker-1',
      queuedForNextTurn: true,
      segmentsIncluded: 1,
    });
    expect(manager.queueContinuityPreamble).toHaveBeenCalledWith(
      'inst-1',
      expect.stringContaining('[Recovered Context From Compaction Marker]'),
    );
    const injected = vi.mocked(manager.queueContinuityPreamble).mock.calls[0]?.[1] ?? '';
    expect(injected).toContain('Wake context for this project.');
    expect(injected).toContain('Important pre-compaction transcript detail.');
    expect(injected).not.toContain('Detail recorded after compaction');
    expect(injected.length).toBeLessThanOrEqual(24_000);
  });

  it('rejects markers that do not belong to the target instance', async () => {
    const db = openMigratedDb();
    recordCompactionMarker(db, {
      id: 'marker-1',
      instanceId: 'other-inst',
      projectKey: '/repo',
      method: 'self-managed',
      createdAt: 200,
    });
    const manager = buildManager();

    await expect(recoverCompactionContext({
      instanceId: 'inst-1',
      markerId: 'marker-1',
    }, {
      db,
      instanceManager: manager,
      getWakeText: () => 'wake',
    })).rejects.toThrow('Compaction marker marker-1 does not belong to instance inst-1');

    expect(manager.queueContinuityPreamble).not.toHaveBeenCalled();
  });

  it('queues recovery context while the current turn is still active', async () => {
    const db = openMigratedDb();
    recordCompactionMarker(db, {
      id: 'marker-1',
      instanceId: 'inst-1',
      projectKey: '/repo',
      method: 'self-managed',
      createdAt: 200,
    });
    const manager = buildManager('busy');

    const result = await recoverCompactionContext({
      instanceId: 'inst-1',
      markerId: 'marker-1',
    }, {
      db,
      instanceManager: manager,
      getWakeText: () => 'wake',
    });

    expect(result.queuedForNextTurn).toBe(true);
    expect(manager.queueContinuityPreamble).toHaveBeenCalledWith('inst-1', expect.stringContaining('wake'));
  });

  it('rejects terminal instances that will not receive another turn', async () => {
    const db = openMigratedDb();
    recordCompactionMarker(db, {
      id: 'marker-1',
      instanceId: 'inst-1',
      projectKey: '/repo',
      method: 'self-managed',
      createdAt: 200,
    });
    const manager = buildManager('terminated');

    await expect(recoverCompactionContext({
      instanceId: 'inst-1',
      markerId: 'marker-1',
    }, {
      db,
      instanceManager: manager,
      getWakeText: () => 'wake',
    })).rejects.toThrow('Cannot recover compaction context for terminal instance inst-1');

    expect(manager.queueContinuityPreamble).not.toHaveBeenCalled();
  });
});
