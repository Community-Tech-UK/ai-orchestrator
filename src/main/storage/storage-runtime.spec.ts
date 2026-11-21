import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import type { StorageFile } from './storage-files';
import type { StorageCleanupProgress } from '../../shared/types/storage.types';
import { createStorageRuntime } from './storage-runtime';

const state = vi.hoisted(() => ({ root: '', files: [] as StorageFile[], release: vi.fn(), observe: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../conversation-ledger/conversation-ledger-service', () => ({ getConversationLedgerService: vi.fn() }));
vi.mock('../rlm/rlm-backup-retention', () => ({ listBackupSetsAsync: vi.fn(), removeBackupSetByName: vi.fn() }));
vi.mock('../rlm/rlm-storage-maintenance-runtime', () => ({ getRlmStorageMaintenance: vi.fn() }));
vi.mock('../session/session-continuity', () => ({ getSessionContinuityManager: () => ({
  waitForRecoveryDiscoveryReady: async () => undefined,
  getRetentionContext: () => ({ stateDir: path.join(state.root, 'states'), metadataDir: path.join(state.root, 'metadata'), dirtyIds: new Set<string>() }),
  forgetRetainedSession: vi.fn(),
}) }));
vi.mock('../history/history-manager', () => ({ getHistoryManager: () => ({ startupTasks: Promise.resolve(), getEntries: () => [] }) }));
vi.mock('../session/session-state-retention', () => ({ listSessionStateCandidates: vi.fn(), sessionStateHistoryIds: vi.fn(), sessionStateIsAbsentFromHistory: vi.fn() }));
vi.mock('../session/session-activity-log-retention', () => ({ listSessionActivityLogCandidates: async () => state.files }));
vi.mock('../session/session-mutex', () => ({ getSessionMutex: () => ({ acquire: async () => { state.observe(); return state.release; } }) }));

describe('storage cleanup runtime progress', () => {
  beforeEach(async () => {
    state.root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'aio-storage-progress-')));
    state.files = []; state.release.mockClear(); state.observe.mockReset();
  });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(state.root, { recursive: true, force: true }); });
  it.each([true, false])('keeps successful unlinks counted when a later file changes (same group=%s)', async sameGroup => {
    const first = path.join(state.root, 'projects', 'first', 'session-events', 'one.jsonl');
    const second = path.join(state.root, 'projects', sameGroup ? 'first' : 'second', 'session-events', 'two.jsonl');
    for (const file of [first, second]) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'fixture'); }
    for (const [index, file] of [first, second].entries()) {
      const stat = await fs.stat(file);
      state.files.push({ path: file, instanceId: sameGroup || index === 0 ? 'first' : 'second', bytes: stat.size, modifiedAt: stat.mtimeMs, changedAt: stat.ctimeMs, inode: stat.ino });
    }
    const unlink = fs.unlink.bind(fs);
    vi.spyOn(fs, 'unlink').mockImplementation(async file => {
      await unlink(file);
      if (file === first) await fs.appendFile(second, 'changed after snapshot');
    });
    const runtime = createStorageRuntime(() => new Set<string>());
    const progressAtAcquire: (StorageCleanupProgress | null)[] = [];
    state.observe.mockImplementation(() => { progressAtAcquire.push(runtime.cleanup.getProgress()); });
    const preview = await runtime.cleanup.preview('activity-logs');
    await expect(runtime.cleanup.run('activity-logs', preview.previewId)).rejects.toThrow('list changed');
    await expect(fs.stat(first)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(second, 'utf8')).toBe('fixturechanged after snapshot');
    expect(progressAtAcquire[0]).toMatchObject({ removed: 0, estimatedTotal: 2, running: true });
    if (!sameGroup) expect(progressAtAcquire[1]).toMatchObject({ removed: 1, estimatedTotal: 2, running: true });
    expect(runtime.cleanup.getProgress()).toMatchObject({ removed: 1, estimatedTotal: 2, running: false });
    expect(state.release).toHaveBeenCalledTimes(sameGroup ? 1 : 2);
  });
});
