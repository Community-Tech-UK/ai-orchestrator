import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listCodexStateOverview, removeCodexSafetyCopies, type CodexSafetyCopy } from './codex-safety-copies';
import { StorageCleanupService, type StorageCleanupDependencies } from './storage-cleanup-service';
import { waitForChangeClockTick } from '../testing/change-clock.test-helpers';

const roots: string[] = [];
const name = 'state_5-before-aio-cleanup-fixture.sqlite';
function unusedPort(port: keyof StorageCleanupDependencies): () => never {
  return () => { throw new Error(`Unexpected storage dependency: ${port}`); };
}
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'codex-reviewed-copy-'));
  roots.push(root);
  const backups = join(root, 'backups');
  const sessions = join(root, 'sessions');
  fs.mkdirSync(backups);
  fs.mkdirSync(sessions);
  const file = join(backups, name);
  fs.writeFileSync(file, 'REVIEWED');
  const overview = () => listCodexStateOverview(backups, sessions);
  const deps: StorageCleanupDependencies = {
    getLedgerStats: unusedPort('getLedgerStats'),
    pruneEvents: unusedPort('pruneEvents'),
    rebuildLedger: unusedPort('rebuildLedger'),
    listBackups: unusedPort('listBackups'),
    removeBackup: unusedPort('removeBackup'),
    isRlmMaintenanceRunning: unusedPort('isRlmMaintenanceRunning'),
    listRecords: unusedPort('listRecords'),
    removeRecords: unusedPort('removeRecords'),
    listLegacyAppData: unusedPort('listLegacyAppData'),
    trashLegacyAppData: unusedPort('trashLegacyAppData'),
    listAttachmentFolders: unusedPort('listAttachmentFolders'),
    removeAttachmentSessions: unusedPort('removeAttachmentSessions'),
    getRtkHistoryPreview: unusedPort('getRtkHistoryPreview'),
    trimRtkHistory: unusedPort('trimRtkHistory'),
    getAvailableDiskBytes: unusedPort('getAvailableDiskBytes'),
    getCodexStateOverview: async () => overview(),
    removeCodexSafetyCopies: async (copies: readonly CodexSafetyCopy[]) => removeCodexSafetyCopies(backups, copies),
  };
  const service = new StorageCleanupService(deps);
  return { root, backups, sessions, file, overview, deps, service };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('reviewed Codex safety copies', () => {
  it('rejects a same-name replacement after preview and consumes the stale ticket', async () => {
    const f = fixture();
    const preview = await f.service.preview('codex-state-backups');
    expect(preview.bytes).toBe(8);
    fs.unlinkSync(f.file);
    fs.writeFileSync(f.file, Buffer.alloc(40, 'x'));
    await expect(f.service.run('codex-state-backups', preview.previewId)).rejects.toThrow(/changed/);
    expect(fs.statSync(f.file).size).toBe(40);
    await expect(f.service.run('codex-state-backups', preview.previewId)).rejects.toThrow();
  });

  it('rejects a same-size rewrite with its original modification date restored', async () => {
    const f = fixture();
    fs.utimesSync(f.file, new Date(1000), new Date(1000));
    const preview = await f.service.preview('codex-state-backups');
    waitForChangeClockTick();
    fs.writeFileSync(f.file, 'REPLACED');
    fs.utimesSync(f.file, new Date(1000), new Date(1000));
    await expect(f.service.run('codex-state-backups', preview.previewId)).rejects.toThrow(/changed/);
    expect(fs.readFileSync(f.file, 'utf8')).toBe('REPLACED');
  });

  it('revalidates identity in the executor after the service snapshot', async () => {
    const f = fixture();
    f.deps.removeCodexSafetyCopies = async copies => {
      fs.renameSync(f.file, join(f.root, 'retained.sqlite'));
      fs.writeFileSync(f.file, Buffer.alloc(40));
      return removeCodexSafetyCopies(f.backups, copies);
    };
    const preview = await f.service.preview('codex-state-backups');
    expect(await f.service.run('codex-state-backups', preview.previewId))
      .toEqual({ target: 'codex-state-backups', removed: 0, bytesFreed: 0 });
    expect(fs.statSync(f.file).size).toBe(40);
  });

  it('excludes symlinks and directories and retains a symlink substituted after review', () => {
    const f = fixture();
    const reviewed = f.overview().copies;
    const retained = join(f.root, 'retained.sqlite');
    fs.writeFileSync(retained, Buffer.alloc(1024));
    fs.unlinkSync(f.file);
    fs.symlinkSync(retained, f.file);
    fs.mkdirSync(join(f.backups, 'state_5-before-aio-archive-directory.sqlite'));
    expect(f.overview().copies).toEqual([]);
    expect(removeCodexSafetyCopies(f.backups, reviewed)).toEqual({ removed: 0, bytesFreed: 0, failed: 1 });
    expect(fs.lstatSync(f.file).isSymbolicLink()).toBe(true);
    expect(fs.statSync(retained).size).toBe(1024);
  });

  it('requires reviewed identities instead of accepting names alone', () => {
    const f = fixture();
    expect(removeCodexSafetyCopies(f.backups, [name] as unknown as readonly CodexSafetyCopy[]))
      .toEqual({ removed: 0, bytesFreed: 0, failed: 1 });
    expect(fs.existsSync(f.file)).toBe(true);
  });

  it('does not credit missing files, and refuses escaped or newly protected candidates', () => {
    const f = fixture();
    const copy = f.overview().copies[0];
    fs.unlinkSync(f.file);
    expect(removeCodexSafetyCopies(f.backups, [copy])).toEqual({ removed: 0, bytesFreed: 0, failed: 1 });
    fs.writeFileSync(f.file, 'REVIEWED');
    expect(removeCodexSafetyCopies(f.backups, [{ ...copy, name: `../${name}` }]))
      .toEqual({ removed: 0, bytesFreed: 0, failed: 1 });
    const names = Array.from({ length: 4 }, (_, i) => `state_5-before-rollout-reconcile-2026010${i + 1}T000000000Z.sqlite`);
    for (const name of names) fs.writeFileSync(join(f.backups, name), 'old');
    const reviewedOldest = f.overview().copies.filter(copy => copy.group === 'old-reconcile');
    expect(reviewedOldest).toHaveLength(1);
    fs.unlinkSync(join(f.backups, names[3]));
    expect(removeCodexSafetyCopies(f.backups, reviewedOldest)).toEqual({ removed: 0, bytesFreed: 0, failed: 1 });
    expect(fs.readFileSync(join(f.backups, names[0]), 'utf8')).toBe('old');
  });

  it('credits only successful unlinks, including zero bytes for retained hardlink content', () => {
    const f = fixture();
    fs.linkSync(f.file, join(f.root, 'retained.sqlite'));
    const reviewed = f.overview().copies;
    expect(removeCodexSafetyCopies(f.backups, [...reviewed, ...reviewed]))
      .toEqual({ removed: 1, bytesFreed: 0, failed: 1 });
    expect(fs.readFileSync(join(f.root, 'retained.sqlite'), 'utf8')).toBe('REVIEWED');
  });

  it('removes an unchanged reviewed copy once while keeping newest-three and automatic copies', async () => {
    const f = fixture();
    const oldNames = Array.from({ length: 4 }, (_, i) => `state_5-before-rollout-reconcile-2026010${i + 1}T000000000Z.sqlite`);
    const automatic = 'state_5-auto-reconcile-20260101T000000000Z.sqlite';
    for (const copy of [...oldNames, automatic]) fs.writeFileSync(join(f.backups, copy), 'old');
    const preview = await f.service.preview('codex-state-backups');
    expect(preview.items.map(item => item.name).sort()).toEqual([name, oldNames[0]].sort());
    expect(await f.service.run('codex-state-backups', preview.previewId))
      .toEqual({ target: 'codex-state-backups', removed: 2, bytesFreed: 11 });
    expect(fs.readdirSync(f.backups).sort()).toEqual([...oldNames.slice(1), automatic].sort());
    await expect(f.service.run('codex-state-backups', preview.previewId)).rejects.toThrow();
  });
});
