import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionState } from '../session-continuity';
import { SnapshotIndex } from '../snapshot-index';
import { SnapshotManager } from '../snapshot-manager';

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    instanceId: 'instance-1',
    sessionId: 'session-1',
    historyThreadId: 'thread-1',
    displayName: 'Snapshot Target',
    agentId: 'build',
    modelId: 'claude-sonnet-4-6',
    provider: 'claude',
    workingDirectory: '/tmp/project',
    conversationHistory: [
      {
        id: 'entry-1',
        role: 'user',
        content: 'hello',
        timestamp: 100,
      },
    ],
    contextUsage: {
      used: 100,
      total: 1_000,
    },
    pendingTasks: [],
    environmentVariables: {},
    activeFiles: [],
    skillsLoaded: [],
    hooksActive: [],
    ...overrides,
  };
}

describe('SnapshotManager', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('creates snapshots, indexes them, and migrates loaded state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-manager-'));
    tempDirs.push(dir);
    const index = new SnapshotIndex();
    const manager = new SnapshotManager(
      dir,
      index,
      {
        writePayload: async (filePath, data) => {
          await fs.promises.writeFile(filePath, JSON.stringify(data), 'utf-8');
        },
        readPayload: async (filePath) => {
          const raw = await fs.promises.readFile(filePath, 'utf-8');
          return JSON.parse(raw) as unknown;
        },
        migrateSessionState: (raw) => ({ ...raw, migrated: true }),
      },
      {
        maxSnapshots: 5,
        maxTotalSnapshots: 10,
        snapshotRetentionDays: 30,
      },
    );

    const snapshot = await manager.createSnapshot(
      makeState(),
      'instance-1',
      'Checkpoint',
      'Before restart',
      'checkpoint',
    );

    expect(snapshot).not.toBeNull();
    expect(index.listForIdentifier('thread-1')).toHaveLength(1);
    expect(manager.listSnapshots('session-1')[0]).toEqual(
      expect.objectContaining({
        id: snapshot?.id,
        historyThreadId: 'thread-1',
        sessionId: 'session-1',
      }),
    );

    const loaded = await manager.loadSnapshot(snapshot!.id);
    expect(loaded?.state).toEqual(expect.objectContaining({ migrated: true }));
  });

  it('prunes expired and excess snapshots for a session', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-manager-prune-'));
    tempDirs.push(dir);
    const index = new SnapshotIndex();
    const manager = new SnapshotManager(
      dir,
      index,
      {
        writePayload: vi.fn(),
        readPayload: vi.fn(),
        migrateSessionState: vi.fn((raw) => raw),
      },
      {
        maxSnapshots: 1,
        maxTotalSnapshots: 10,
        snapshotRetentionDays: 30,
      },
    );

    const recentId = 'snap-recent';
    const oldId = 'snap-old';
    const veryOldId = 'snap-expired';
    await fs.promises.writeFile(path.join(dir, `${recentId}.json`), '{}', 'utf-8');
    await fs.promises.writeFile(path.join(dir, `${oldId}.json`), '{}', 'utf-8');
    await fs.promises.writeFile(path.join(dir, `${veryOldId}.json`), '{}', 'utf-8');
    index.add({
      id: recentId,
      instanceId: 'instance-1',
      sessionId: 'session-1',
      historyThreadId: 'thread-1',
      timestamp: Date.now(),
      messageCount: 1,
      schemaVersion: 2,
    });
    index.add({
      id: oldId,
      instanceId: 'instance-1',
      sessionId: 'session-1',
      historyThreadId: 'thread-1',
      timestamp: Date.now() - 1_000,
      messageCount: 1,
      schemaVersion: 2,
    });
    index.add({
      id: veryOldId,
      instanceId: 'instance-1',
      sessionId: 'session-1',
      historyThreadId: 'thread-1',
      timestamp: Date.now() - 40 * 24 * 60 * 60 * 1000,
      messageCount: 1,
      schemaVersion: 2,
    });

    await manager.cleanupSnapshots('session-1');

    expect(fs.existsSync(path.join(dir, `${recentId}.json`))).toBe(true);
    expect(fs.existsSync(path.join(dir, `${oldId}.json`))).toBe(false);
    expect(fs.existsSync(path.join(dir, `${veryOldId}.json`))).toBe(false);
    expect(index.listForIdentifier('session-1').map((meta) => meta.id)).toEqual([recentId]);
  });
});
