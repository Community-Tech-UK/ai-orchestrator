import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStorageRuntime } from './storage-runtime';
import { previewRtkHistoryTrim, trimRtkHistory } from '../cli/rtk/rtk-history-trim';
import type { StorageCleanupProgress } from '../../shared/types/storage.types';

const runtime = vi.hoisted(() => ({ root: '', projects: new Array<string>(), dirtyIds: new Set<string>(), bin: vi.fn(async (_path: string) => undefined),
  release: vi.fn(), observe: vi.fn(), afterUnlink: null as ((file: string) => void) | null }));
vi.mock('fs', async original => {
  const actual = await original<typeof import('fs')>();
  return { ...actual, unlinkSync: (file: string) => { actual.unlinkSync(file); runtime.afterUnlink?.(file); } };
});
vi.mock('electron', () => ({ app: { getPath: (name: string) => name === 'appData' ? join(runtime.root, 'app-data') : runtime.root }, shell: { trashItem: runtime.bin } }));
vi.mock('../conversation-ledger/conversation-ledger-service', () => ({ getConversationLedgerService: () => ({}) }));
vi.mock('../core/config/recent-directories-manager', () => ({ getRecentDirectoriesManager: () => ({ getDirectories: async () => runtime.projects.map(path => ({ path })) }) }));
vi.mock('../rlm/rlm-backup-retention', () => ({ listBackupSetsAsync: async () => [], removeBackupSetByName: vi.fn() }));
vi.mock('../rlm/rlm-storage-maintenance-runtime', () => ({ getRlmStorageMaintenance: () => ({ isRunning: () => false }) }));
vi.mock('../session/session-continuity', () => ({ getSessionContinuityManager: () => ({
  waitForRecoveryDiscoveryReady: async () => undefined,
  getRetentionContext: () => ({ stateDir: join(runtime.root, 'states'), metadataDir: join(runtime.root, 'metadata'), dirtyIds: runtime.dirtyIds }),
  forgetRetainedSession: vi.fn(),
}) }));
vi.mock('../session/session-mutex', () => ({ getSessionMutex: () => ({ acquire: async () => { runtime.observe(); return runtime.release; } }) }));
vi.mock('../cli/adapters/codex/codex-home-manager', () => ({ getAioCodexStateDir: () => join(runtime.root, 'codex'), getAioCodexSessionsDir: () => join(runtime.root, 'codex-sessions') }));
vi.mock('../cli/rtk/rtk-history-trim', () => ({ previewRtkHistoryTrim: vi.fn(), trimRtkHistory: vi.fn() }));

describe('storage runtime reviewed cleanup bindings', () => {
  beforeEach(async () => {
    runtime.root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'storage-runtime-identities-')));
    runtime.bin.mockClear();
    runtime.projects = [];
    runtime.dirtyIds.clear();
    runtime.release.mockClear();
    runtime.observe.mockReset();
    runtime.afterUnlink = null;
  });
  afterEach(async () => { await fs.rm(runtime.root, { recursive: true, force: true }); });

  it('passes the approved database and fixed date to the RTK executor after background pruning', async () => {
    const dbPath = join(runtime.root, 'rtk.db');
    const previewData = { available: true, dbPath, fileBytes: 600, commandsToRemove: 400, failuresToRemove: 100,
      oldestAt: 10, newestAt: 90, cutoffAt: 50, estimatedBytes: 240 };
    vi.mocked(previewRtkHistoryTrim).mockReturnValueOnce(previewData)
      .mockReturnValueOnce({ ...previewData, commandsToRemove: 300, failuresToRemove: 50 });
    vi.mocked(trimRtkHistory).mockResolvedValue({ removedCommands: 300, removedFailures: 50, stoppedEarly: false });
    const { cleanup } = createStorageRuntime(() => new Set());
    const preview = await cleanup.preview('rtk-history');
    expect(await cleanup.run('rtk-history', preview.previewId)).toEqual({ target: 'rtk-history', removed: 350, bytesFreed: 0, stoppedEarly: false });
    const previewOptions = vi.mocked(previewRtkHistoryTrim).mock.calls.at(-2)![1]!;
    const runOptions = vi.mocked(trimRtkHistory).mock.calls.at(-1)![1]!;
    expect(runOptions.dbPath).toBe(dbPath);
    expect(runOptions.now!()).toBe(previewOptions.now!());
  });

  it('credits a hard-linked activity log once across separate session mutex groups', async () => {
    const logs = join(runtime.root, 'projects', 'project', 'session-events');
    await fs.mkdir(logs, { recursive: true });
    const first = join(logs, 'first.jsonl');
    await fs.writeFile(first, Buffer.alloc(1024));
    await fs.link(first, join(logs, 'second.jsonl'));
    await fs.utimes(first, new Date(1), new Date(1));
    const { cleanup } = createStorageRuntime(() => new Set());
    const preview = await cleanup.preview('activity-logs');
    expect(preview.bytes).toBe(2048);
    expect(await cleanup.run('activity-logs', preview.previewId)).toEqual({ target: 'activity-logs', removed: 2, bytesFreed: 1024 });
    expect(await fs.readdir(logs)).toEqual([]);
  });

  it('refuses a replacement through the real legacy runtime Bin binding', async () => {
    const appData = join(runtime.root, 'app-data');
    const legacy = join(appData, 'claude-orchestrator');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(join(legacy, 'settings'), 'aaaa');
    await fs.utimes(join(legacy, 'settings'), new Date(1), new Date(1));
    const { cleanup } = createStorageRuntime(() => new Set());
    const preview = await cleanup.preview('legacy-app-data');
    await fs.rename(legacy, join(appData, 'retained'));
    await fs.mkdir(legacy);
    await fs.writeFile(join(legacy, 'settings'), 'bbbb');
    await fs.utimes(join(legacy, 'settings'), new Date(1), new Date(1));
    await expect(cleanup.run('legacy-app-data', preview.previewId)).rejects.toThrow(/Review again/);
    expect(runtime.bin).not.toHaveBeenCalled();
    expect(await fs.readFile(join(legacy, 'settings'), 'utf8')).toBe('bbbb');
  });

  it.each(['live', 'dirty'] as const)('retains newly %s protected attachment sessions through the real runtime', async protection => {
    const project = join(runtime.root, 'project');
    const session = join(project, '.claude-attachments', 'protected-session');
    const file = join(session, 'paste');
    await fs.mkdir(session, { recursive: true });
    await fs.writeFile(file, 'REVIEWED');
    await fs.utimes(file, new Date(1), new Date(1));
    runtime.projects = [project];
    const liveIds = new Set<string>();
    const { cleanup } = createStorageRuntime(() => liveIds);
    const preview = await cleanup.preview('claude-attachments');
    expect(preview.estimatedCount).toBe(1);
    (protection === 'live' ? liveIds : runtime.dirtyIds).add('protected-session');
    expect(await cleanup.run('claude-attachments', preview.previewId))
      .toEqual({ target: 'claude-attachments', removed: 0, bytesFreed: 0 });
    expect(await fs.readFile(file, 'utf8')).toBe('REVIEWED');
    expect((await cleanup.preview('claude-attachments')).estimatedCount).toBe(0);
  });

  it('protects provider-session-named attachment folders when live identities include both Harness and provider IDs', async () => {
    const project = join(runtime.root, 'project');
    const harnessInstanceId = 'harness-instance-aaa';
    const providerSessionId = 'provider-session-bbb';
    const session = join(project, '.claude-attachments', providerSessionId);
    const file = join(session, 'paste');
    await fs.mkdir(session, { recursive: true });
    await fs.writeFile(file, 'REVIEWED');
    await fs.utimes(file, new Date(1), new Date(1));
    runtime.projects = [project];

    // Without the provider session ID in the set, the folder is offered for clearing.
    const harnessOnly = new Set([harnessInstanceId]);
    const { cleanup: withoutProvider } = createStorageRuntime(() => harnessOnly);
    expect((await withoutProvider.preview('claude-attachments')).estimatedCount).toBe(1);

    // With both identity types (the ipc-main-handler contract), the folder is protected.
    const bothIds = new Set([harnessInstanceId, providerSessionId]);
    const { cleanup: withBoth } = createStorageRuntime(() => bothIds);
    expect((await withBoth.preview('claude-attachments')).estimatedCount).toBe(0);
    expect(await fs.readFile(file, 'utf8')).toBe('REVIEWED');
  });

  it.each([true, false])('keeps successful unlinks counted when a later file changes (same group=%s)', async sameGroup => {
    // The activity-log lister groups files by their name, so the same name in two projects is one session.
    const first = join(runtime.root, 'projects', 'first', 'session-events', 'one.jsonl');
    const second = join(runtime.root, 'projects', 'second', 'session-events', sameGroup ? 'one.jsonl' : 'two.jsonl');
    for (const file of [first, second]) {
      await fs.mkdir(join(file, '..'), { recursive: true });
      await fs.writeFile(file, 'fixture');
      await fs.utimes(file, new Date(1), new Date(1));
    }
    runtime.afterUnlink = file => { if (file === first) appendFileSync(second, 'changed after snapshot'); };
    const { cleanup } = createStorageRuntime(() => new Set<string>());
    const progressAtAcquire: (StorageCleanupProgress | null)[] = [];
    runtime.observe.mockImplementation(() => { progressAtAcquire.push(cleanup.getProgress()); });
    const preview = await cleanup.preview('activity-logs');
    await expect(cleanup.run('activity-logs', preview.previewId)).rejects.toThrow('list changed');
    await expect(fs.stat(first)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(second, 'utf8')).toBe('fixturechanged after snapshot');
    expect(progressAtAcquire[0]).toMatchObject({ removed: 0, estimatedTotal: 2, running: true });
    if (!sameGroup) expect(progressAtAcquire[1]).toMatchObject({ removed: 1, estimatedTotal: 2, running: true });
    expect(cleanup.getProgress()).toMatchObject({ removed: 1, estimatedTotal: 2, running: false });
    expect(runtime.release).toHaveBeenCalledTimes(sameGroup ? 1 : 2);
  });
});
