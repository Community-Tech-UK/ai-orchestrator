import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs, writeFileSync, utimesSync, existsSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listAttachmentFolders, removeAttachmentSessions } from './attachments-folders';
import { StorageCleanupService, type StorageCleanupDependencies } from './storage-cleanup-service';
import { waitForChangeClockTick } from '../testing/change-clock.test-helpers';

const NOW = Date.now();
const OLD = new Date(NOW - 40 * 86_400_000);
let root = '';
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = '';
});

async function fixture() {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'attachment-generation-')));
  const project = join(root, 'project');
  const session = join(project, '.claude-attachments', 'old-session');
  const nested = join(session, 'nested');
  const file = join(nested, 'paste.txt');
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(file, 'REVIEWED');
  await fs.utimes(file, OLD, OLD);
  const unused = async (): Promise<never> => { throw new Error('Unexpected cleanup port'); };
  const deps: StorageCleanupDependencies = {
    getLedgerStats: unused, pruneEvents: unused, rebuildLedger: unused,
    listBackups: unused, removeBackup: () => { throw new Error('Unexpected backup'); },
    isRlmMaintenanceRunning: () => false, listRecords: unused, removeRecords: unused,
    listLegacyAppData: unused, trashLegacyAppData: unused,
    listAttachmentFolders: now => listAttachmentFolders([project], now),
    removeAttachmentSessions,
    getCodexStateOverview: unused, removeCodexSafetyCopies: unused,
    getRtkHistoryPreview: unused, trimRtkHistory: unused,
    getAvailableDiskBytes: unused,
    now: () => NOW,
  };
  return { project, session, nested, file, deps, service: new StorageCleanupService(deps) };
}

async function rewrite(file: string) {
  const before = await fs.lstat(file);
  waitForChangeClockTick();
  await fs.writeFile(file, 'REPLACED');
  await fs.utimes(file, OLD, OLD);
  const after = await fs.lstat(file);
  expect(after.ino).toBe(before.ino);
  expect(after.size).toBe(before.size);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(after.ctimeMs).not.toBe(before.ctimeMs);
}

describe('attachment preview authority through actual executor', () => {
  it('replaces abandoned attachment previews while preserving other cleanup approvals', async () => {
    const f = await fixture();
    f.deps.listBackups = () => [{ name: 'new', bytes: 4, createdAt: 2 }, { name: 'old', bytes: 4, createdAt: 1 }];
    f.deps.removeBackup = () => ({ deleted: 1, bytesFreed: 4, failed: 0 });
    const backup = await f.service.preview('rlm-backups');
    const previews = [await f.service.preview('claude-attachments')];
    for (let index = 1; index < 20; index++) previews.push(await f.service.preview('claude-attachments'));
    for (const preview of previews.slice(0, -1)) {
      await expect(f.service.run('claude-attachments', preview.previewId)).rejects.toThrow(/review/i);
    }
    expect(await fs.readFile(f.file, 'utf8')).toBe('REVIEWED');
    expect(await f.service.run('rlm-backups', backup.previewId))
      .toEqual({ target: 'rlm-backups', removed: 1, bytesFreed: 4 });
    expect(await f.service.run('claude-attachments', previews.at(-1)!.previewId))
      .toEqual({ target: 'claude-attachments', removed: 1, bytesFreed: 8 });
  });

  it('bounds reviewed authority across projects while measuring both and offering the next batch', async () => {
    const f = await fixture();
    const other = join(root, 'other-project');
    const second = join(other, '.claude-attachments', 'old-session');
    const secondFile = join(second, 'paste.txt');
    await fs.mkdir(second, { recursive: true });
    await fs.writeFile(secondFile, 'REVIEWED');
    await fs.utimes(secondFile, OLD, OLD);
    for (const directory of [f.nested, second]) {
      for (let start = 0; start < 26_000; start += 200) {
        await Promise.all(Array.from({ length: 200 }, async (_, offset) => {
          const file = join(directory, `old-${start + offset}`);
          await fs.writeFile(file, '');
          await fs.utimes(file, OLD, OLD);
        }));
      }
    }
    const folders = await listAttachmentFolders([f.project, other], NOW);
    expect(folders.map(folder => folder.bytes)).toEqual([8, 8]);
    expect(folders.map(folder => folder.totalSessions)).toEqual([1, 1]);
    expect(folders.map(folder => folder.clearable.length)).toEqual([1, 0]);
    expect(await fs.readFile(secondFile, 'utf8')).toBe('REVIEWED');
    // Model the prior batch being removed; the next review must offer the rest.
    await fs.rm(f.session, { recursive: true });
    const next = await listAttachmentFolders([f.project, other], NOW);
    expect(next[1].clearable.map(session => session.path)).toEqual([second]);
  }, 60_000);

  it('refuses an oversized dependency inventory before discarding a valid reviewed preview', async () => {
    const f = await fixture();
    const approved = await f.service.preview('claude-attachments');
    const folders = await listAttachmentFolders([f.project], NOW);
    const session = folders[0].clearable[0];
    const tree = session.tree!;
    f.deps.listAttachmentFolders = async () => [{ ...folders[0], clearable: [{ ...session,
      tree: { ...tree, entries: Array.from({ length: 50_001 }, () => tree.entries[0]) },
    }] }];
    await expect(f.service.preview('claude-attachments')).rejects.toThrow(/too large|entry limit/i);
    f.deps.listAttachmentFolders = now => listAttachmentFolders([f.project], now);
    expect(await f.service.run('claude-attachments', approved.previewId))
      .toEqual({ target: 'claude-attachments', removed: 1, bytesFreed: 8 });
  });

  it.each(['before-run', 'after-service-revalidation'] as const)('retains same-inode restored-mtime writes %s', async timing => {
    const f = await fixture();
    const preview = await f.service.preview('claude-attachments');
    expect(preview.estimatedCount).toBe(1);
    const folder = await fs.lstat(f.session);
    if (timing === 'before-run') await rewrite(f.file);
    else f.deps.removeAttachmentSessions = async sessions => {
      await rewrite(f.file);
      return removeAttachmentSessions(sessions);
    };
    expect((await fs.lstat(f.session)).ctimeMs).toBe(folder.ctimeMs);
    expect(await f.service.run('claude-attachments', preview.previewId))
      .toEqual({ target: 'claude-attachments', removed: 0, bytesFreed: 0 });
    expect(await fs.readFile(f.file, 'utf8')).toBe('REPLACED');
    await expect(f.service.run('claude-attachments', preview.previewId)).rejects.toThrow(/Review|review/);
  });

  it.each((['file-inode', 'subtree', 'new-path', 'directory', 'symlink', 'missing'] as const)
    .flatMap(kind => (['before-run', 'after-service-revalidation'] as const).map(timing => ({ kind, timing }))))('retains changed $kind $timing', async ({ kind, timing }) => {
      const f = await fixture();
      const preview = await f.service.preview('claude-attachments');
      const mutate = async () => {
        if (kind === 'file-inode') {
          await fs.rename(f.file, join(root, 'retained'));
          await fs.writeFile(f.file, 'REPLACED');
          await fs.utimes(f.file, OLD, OLD);
        } else if (kind === 'subtree' || kind === 'directory') {
          const target = kind === 'subtree' ? f.nested : f.session;
          await fs.rename(target, join(root, 'retained'));
          await fs.mkdir(f.nested, { recursive: true });
          await fs.writeFile(f.file, 'REPLACED');
          await fs.utimes(f.file, OLD, OLD);
        } else if (kind === 'new-path') {
          await fs.writeFile(join(f.nested, 'unreviewed'), '');
          await fs.utimes(join(f.nested, 'unreviewed'), OLD, OLD);
        } else if (kind === 'symlink') {
          await fs.symlink(f.file, join(f.nested, 'linked'));
        } else await fs.unlink(f.file);
      };
      if (timing === 'before-run') await mutate();
      else f.deps.removeAttachmentSessions = async sessions => {
        await mutate();
        return removeAttachmentSessions(sessions);
      };
      expect(await f.service.run('claude-attachments', preview.previewId))
        .toEqual({ target: 'claude-attachments', removed: 0, bytesFreed: 0 });
      expect((await fs.lstat(f.session)).isDirectory()).toBe(true);
      if (kind !== 'missing') expect(await fs.readFile(f.file, 'utf8'))
        .toBe(['file-inode', 'subtree', 'directory'].includes(kind) ? 'REPLACED' : 'REVIEWED');
  });

  it('removes an unchanged reviewed nested tree and reports actual content', async () => {
    const f = await fixture();
    await fs.mkdir(join(f.nested, 'empty'));
    const preview = await f.service.preview('claude-attachments');
    expect(await f.service.run('claude-attachments', preview.previewId))
      .toEqual({ target: 'claude-attachments', removed: 1, bytesFreed: 8 });
    await expect(fs.lstat(f.session)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([false, true])('keeps last-link receipts across project folders (retained=%s)', async retained => {
    const f = await fixture();
    const other = join(root, 'other');
    const second = join(other, '.claude-attachments', 'other-session', 'paste.txt');
    await fs.mkdir(join(other, '.claude-attachments', 'other-session'), { recursive: true });
    await fs.link(f.file, second);
    if (retained) await fs.link(f.file, join(root, 'retained'));
    f.deps.listAttachmentFolders = now => listAttachmentFolders([f.project, other], now);
    const preview = await f.service.preview('claude-attachments');
    expect(preview.estimatedCount).toBe(2);
    expect(await f.service.run('claude-attachments', preview.previewId))
      .toEqual({ target: 'claude-attachments', removed: 2, bytesFreed: retained ? 0 : 8 });
    if (retained) expect(await fs.readFile(join(root, 'retained'), 'utf8')).toBe('REVIEWED');
  });

  it('does not inventory a changed second project as approved while removing the first', async () => {
    const f = await fixture();
    const other = join(root, 'other');
    const second = join(other, '.claude-attachments', 'other-session', 'paste.txt');
    await fs.mkdir(join(other, '.claude-attachments', 'other-session'), { recursive: true });
    await fs.writeFile(second, 'REVIEWED');
    await fs.utimes(second, OLD, OLD);
    f.deps.listAttachmentFolders = now => listAttachmentFolders([f.project, other], now);
    const preview = await f.service.preview('claude-attachments');
    f.deps.removeAttachmentSessions = async sessions => {
      await rewrite(second);
      return removeAttachmentSessions(sessions);
    };
    expect(await f.service.run('claude-attachments', preview.previewId))
      .toEqual({ target: 'claude-attachments', removed: 1, bytesFreed: 8 });
    expect(await fs.readFile(second, 'utf8')).toBe('REPLACED');
  });

  it('refuses an unstable generation when an earlier file changes during the scan', async () => {
    const f = await fixture();
    await fs.mkdir(join(f.nested, 'z-last'));
    const read = fs.readdir.bind(fs);
    vi.spyOn(fs, 'readdir').mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
      const entries = await read(...args);
      if (String(args[0]) === join(f.nested, 'z-last')) {
        waitForChangeClockTick();
        writeFileSync(f.file, 'CHANGED!');
        utimesSync(f.file, OLD, OLD);
      }
      return entries;
    });
    expect((await listAttachmentFolders([f.project], NOW))[0].clearable).toEqual([]);
    expect(await fs.readFile(f.file, 'utf8')).toBe('CHANGED!');
  });

  it('refuses a direct stale descriptor instead of granting a new inventory', async () => {
    const f = await fixture();
    const [usage] = await listAttachmentFolders([f.project], NOW);
    await rewrite(f.file);
    expect(await removeAttachmentSessions(usage.clearable)).toEqual({ removed: 0, bytesFreed: 0 });
    expect(await fs.readFile(f.file, 'utf8')).toBe('REPLACED');
  });

  it('never offers an ancestor-linked project root', async () => {
    const f = await fixture();
    const linked = join(root, 'linked-project');
    await fs.symlink(f.project, linked);
    expect(await listAttachmentFolders([linked], NOW)).toEqual([]);
    expect(await fs.readFile(f.file, 'utf8')).toBe('REVIEWED');
  });

  it('retains a linked attachment root swapped after service revalidation', async () => {
    const f = await fixture();
    const preview = await f.service.preview('claude-attachments');
    const folder = join(f.project, '.claude-attachments');
    const retained = join(root, 'retained-folder');
    f.deps.removeAttachmentSessions = async sessions => {
      await fs.rename(folder, retained);
      await fs.symlink(retained, folder);
      return removeAttachmentSessions(sessions);
    };
    expect(await f.service.run('claude-attachments', preview.previewId))
      .toEqual({ target: 'claude-attachments', removed: 0, bytesFreed: 0 });
    expect(await fs.readFile(f.file, 'utf8')).toBe('REVIEWED');
  });

  it.each(['preview', 'run'] as const)('refuses a real tree with an injected directory read error during %s', async timing => {
    const f = await fixture();
    const preview = timing === 'run' ? await f.service.preview('claude-attachments') : undefined;
    const read = fs.readdir.bind(fs);
    vi.spyOn(fs, 'readdir').mockImplementation(async (...args) => {
      if (String(args[0]) === f.nested) throw Object.assign(new Error('unreadable fixture'), { code: 'EACCES' });
      return read(...args);
    });
    if (preview) expect(await f.service.run('claude-attachments', preview.previewId))
      .toEqual({ target: 'claude-attachments', removed: 0, bytesFreed: 0 });
    else expect((await f.service.preview('claude-attachments')).estimatedCount).toBe(0);
    expect(await fs.readFile(f.file, 'utf8')).toBe('REVIEWED');
  });

  it('refuses a missing file encountered during the generation scan', async () => {
    const f = await fixture();
    const read = fs.readdir.bind(fs);
    vi.spyOn(fs, 'readdir').mockImplementation(async (...args) => {
      const names = await read(...args);
      if (String(args[0]) === f.nested) await fs.unlink(f.file);
      return names;
    });
    expect((await f.service.preview('claude-attachments')).estimatedCount).toBe(0);
    expect((await fs.lstat(f.session)).isDirectory()).toBe(true);
  });

  it('excludes protected IDs at discovery and rechecks protection at the actual deletion boundary', async () => {
    const f = await fixture();
    const ids = new Set<string>(['old-session']);
    expect((await listAttachmentFolders([f.project], NOW, () => ids))[0].clearable).toEqual([]);
    ids.clear();
    f.deps.listAttachmentFolders = now => listAttachmentFolders([f.project], now, () => ids);
    const preview = await f.service.preview('claude-attachments');
    f.deps.removeAttachmentSessions = sessions => removeAttachmentSessions(sessions, {
      getProtectedIds: () => { ids.add('old-session'); return ids; },
    });
    expect(await f.service.run('claude-attachments', preview.previewId))
      .toEqual({ target: 'claude-attachments', removed: 0, bytesFreed: 0 });
    expect(await fs.readFile(f.file, 'utf8')).toBe('REVIEWED');
  });

  it('rejects an external hardlink rewrite after our first selected unlink', async () => {
    const f = await fixture();
    const second = join(f.nested, 'second');
    await fs.link(f.file, second);
    const [usage] = await listAttachmentFolders([f.project], NOW);
    let mutated = false;
    await expect(removeAttachmentSessions(usage.clearable, { getProtectedIds: () => {
      if (!mutated && !existsSync(f.file)) {
        mutated = true;
        waitForChangeClockTick();
        writeFileSync(second, 'REPLACED');
        utimesSync(second, OLD, OLD);
      }
      return new Set();
    } })).rejects.toThrow(/Review again/);
    expect(mutated).toBe(true);
    expect(await fs.readFile(second, 'utf8')).toBe('REPLACED');
  });

  it.each(['files', 'directories'] as const)('refuses a realistically wide tree of %s at the entry cap', async kind => {
    const f = await fixture();
    // Real filesystem entries, not duplicated synthetic dirents. Empty directories
    // must consume the same bounded budget as files.
    for (let start = 0; start < 50_000; start += 200) {
      await Promise.all(Array.from({ length: 200 }, (_, offset) => {
        const entry = join(f.nested, `empty-${start + offset}`);
        return kind === 'directories' ? fs.mkdir(entry) : fs.writeFile(entry, '');
      }));
    }
    expect((await f.service.preview('claude-attachments')).estimatedCount).toBe(0);
    expect((await fs.readdir(f.nested)).length).toBe(50_001);
    expect(await fs.readFile(f.file, 'utf8')).toBe('REVIEWED');
  }, 60_000);


  it('retains the original descriptor when a listing dependency mutates its returned objects', async () => {
    const f = await fixture();
    const folders = await listAttachmentFolders([f.project], NOW);
    f.deps.listAttachmentFolders = async () => folders;
    const preview = await f.service.preview('claude-attachments');
    await rewrite(f.file);
    // Reuse the dependency-owned outer arrays with newly measured descriptors.
    folders[0].clearable.splice(0, folders[0].clearable.length,
      ...(await listAttachmentFolders([f.project], NOW))[0].clearable);
    expect(await f.service.run('claude-attachments', preview.previewId))
      .toEqual({ target: 'claude-attachments', removed: 0, bytesFreed: 0 });
    expect(await fs.readFile(f.file, 'utf8')).toBe('REPLACED');
  });

  it('refuses an executor-boundary permission change after service revalidation', async () => {
    const f = await fixture();
    const preview = await f.service.preview('claude-attachments');
    f.deps.removeAttachmentSessions = async sessions => {
      await fs.chmod(f.nested, 0);
      try { return await removeAttachmentSessions(sessions); }
      finally { await fs.chmod(f.nested, 0o700); }
    };
    expect(await f.service.run('claude-attachments', preview.previewId))
      .toEqual({ target: 'claude-attachments', removed: 0, bytesFreed: 0 });
    expect(await fs.readFile(f.file, 'utf8')).toBe('REVIEWED');
  });


  it('refuses a newly added nested path at the unlink boundary after tree preflight', async () => {
    const f = await fixture();
    const [usage] = await listAttachmentFolders([f.project], NOW);
    const added = join(f.nested, 'unreviewed');
    let checks = 0;
    await expect(removeAttachmentSessions(usage.clearable, { getProtectedIds: () => {
      if (++checks === 3) {
        waitForChangeClockTick();
        writeFileSync(added, '');
        utimesSync(added, OLD, OLD);
      }
      return new Set();
    } })).rejects.toThrow(/Review again/);
    expect(await fs.readFile(f.file, 'utf8')).toBe('REVIEWED');
    expect(await fs.readFile(added, 'utf8')).toBe('');
  });

  it('rechecks the age cutoff for direct API callers at execution', async () => {
    const f = await fixture();
    const [usage] = await listAttachmentFolders([f.project], NOW);
    expect(usage.clearable).toHaveLength(1);
    expect(await removeAttachmentSessions(usage.clearable, { now: () => OLD.getTime() + 86_400_000 }))
      .toEqual({ removed: 0, bytesFreed: 0 });
    expect(await fs.readFile(f.file, 'utf8')).toBe('REVIEWED');
  });


  it('rechecks a linked root after querying current protection at a direct file unlink boundary', async () => {
    const f = await fixture();
    const folder = join(f.project, '.claude-attachments');
    const copy = join(folder, 'old-file');
    await fs.writeFile(copy, 'REVIEWED');
    await fs.utimes(copy, OLD, OLD);
    const [usage] = await listAttachmentFolders([f.project], NOW);
    const selected = usage.clearable.filter(session => session.path === copy);
    expect(selected).toHaveLength(1);
    let checks = 0;
    const retained = join(root, 'retained-folder');
    await expect(removeAttachmentSessions(selected, { getProtectedIds: () => {
      if (++checks === 3) {
        renameSync(folder, retained);
        symlinkSync(retained, folder);
      }
      return new Set();
    } })).rejects.toThrow(/Review again/);
    expect(await fs.readFile(join(retained, 'old-file'), 'utf8')).toBe('REVIEWED');
  });

});
