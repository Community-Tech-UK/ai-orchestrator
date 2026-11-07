import { mkdtempSync, writeFileSync, readdirSync, rmSync, mkdirSync, statSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { getLogger } from '../../../logging/logger';
import { migrateCodexBackupRetention, pruneCodexBackupsAtStartup, pruneConfiguredCodexBackups } from './codex-backup-retention-policy';

describe('configured Codex retention', () => {
  it.each(['EACCES', 'ENOTDIR'])('leaves an unreadable %s migration pending without stopping startup', code => {
    const values = new Map<string, unknown>();
    const store = { get: (key: string) => values.get(key), persistSetting: (key: string, value: unknown) => { values.set(key, value); }, persistRawSetting: (key: string, value: unknown) => { values.set(key, value); } };
    expect(() => migrateCodexBackupRetention(store, () => { throw Object.assign(new Error('Cannot list backup directory'), { code }); })).not.toThrow();
    expect(values.size).toBe(0);
    migrateCodexBackupRetention(store, () => true);
    expect(values.get('codexBackupKeepThree')).toBe(true);
    expect(values.get('__migration_codex_backup_keep_three_20261020')).toBe(true);
  });

  it('does nothing when off, then removes old reconcile copies and reports actual bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-retention-'));
    try {
      const names = Array.from({ length: 10 }, (_, i) => `state_5-before-rollout-reconcile-202601${String(i + 1).padStart(2, '0')}T000000000Z.sqlite`);
      for (const name of names) writeFileSync(join(dir, name), '1234');
      writeFileSync(join(dir, 'state_5-before-aio-cleanup-example.sqlite'), 'keep');
      expect(pruneConfiguredCodexBackups(false, dir).removed).toBe(0);
      expect(pruneConfiguredCodexBackups(true, dir)).toMatchObject({ removed: 7, bytesFreed: 28 });
      expect(readdirSync(dir).sort()).toEqual([...names.slice(-3), 'state_5-before-aio-cleanup-example.sqlite'].sort());
      expect(pruneConfiguredCodexBackups(true, dir)).toMatchObject({ removed: 0, bytesFreed: 0 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses directories and symlinks, while preserving the newest three regular backups', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-retention-'));
    try {
      const names = Array.from({ length: 5 }, (_, i) => `state_5-before-rollout-reconcile-2026010${i + 1}T000000000Z.sqlite`);
      mkdirSync(join(dir, names[0]));
      symlinkSync(join(dir, 'external'), join(dir, names[1]));
      for (const name of names.slice(2)) writeFileSync(join(dir, name), 'kept');
      expect(pruneConfiguredCodexBackups(true, dir)).toMatchObject({ removed: 0, bytesFreed: 0 });
      expect(readdirSync(dir)).toHaveLength(5);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('migrates the approved existing backup backlog once; fresh installs remain off', () => {
    const values = new Map<string, unknown>();
    const store = { get: (key: string) => values.get(key), persistSetting: (key: string, value: unknown) => { values.set(key, value); }, persistRawSetting: (key: string, value: unknown) => { values.set(key, value); } };
    migrateCodexBackupRetention(store, () => false);
    expect(values.get('codexBackupKeepThree')).toBeUndefined();
    values.clear();
    migrateCodexBackupRetention(store, () => true);
    expect(values.get('codexBackupKeepThree')).toBe(true);
    values.set('codexBackupKeepThree', false);
    migrateCodexBackupRetention(store, () => true);
    expect(values.get('codexBackupKeepThree')).toBe(false);
  });
});

describe('combined startup pruning', () => {
  const cleanup = 'state_5-before-aio-cleanup-20260101T000000000Z.sqlite';
  const archive = 'state_5-before-aio-archive-20260102T000000000Z.sqlite';
  const reconcile = Array.from({ length: 6 }, (_, i) => `state_5-before-rollout-reconcile-2026010${i + 3}T000000000Z.sqlite`);
  const fixture = [
    { name: cleanup, size: 11 },
    { name: archive, size: 12 },
    ...reconcile.map((name, index) => ({ name, size: 20 + index })),
  ];

  let dir: string;
  let policyInfo: MockInstance<ReturnType<typeof getLogger>['info']>;
  let safetyInfo: MockInstance<ReturnType<typeof getLogger>['info']>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-startup-prune-'));
    fixture.forEach(({ name, size }, index) => {
      const file = join(dir, name);
      writeFileSync(file, 'x'.repeat(size));
      const mtime = new Date(1_600_000_000_000 + index * 60_000);
      utimesSync(file, mtime, mtime);
    });
    policyInfo = vi.spyOn(getLogger('CodexBackupRetentionPolicy'), 'info');
    safetyInfo = vi.spyOn(getLogger('CodexStateBackupRetention'), 'info');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function sizes(): Map<string, number> {
    return new Map(readdirSync(dir).map((name) => [name, statSync(join(dir, name)).size]));
  }

  function delta(before: Map<string, number>, after: Map<string, number>): { removed: number; bytesFreed: number } {
    const removedNames = [...before.keys()].filter((name) => !after.has(name));
    return {
      removed: removedNames.length,
      bytesFreed: removedNames.reduce((sum, name) => sum + before.get(name)!, 0),
    };
  }

  it('with keep-3 on removes only surplus reconcile copies, keeps clean-up and archive backups, and its log matches the filesystem delta', () => {
    const before = sizes();
    const result = pruneCodexBackupsAtStartup(true, dir);
    const after = sizes();
    const { removed, bytesFreed } = delta(before, after);

    expect([...after.keys()].sort()).toEqual([cleanup, archive, ...reconcile.slice(3)].sort());
    expect(result).toEqual({ selected: 3, removed: 3, failed: 0, bytesFreed });
    expect(removed).toBe(3);
    const logged = policyInfo.mock.calls.find(([message]) => message === 'Codex backup keep-3 run')?.[1];
    expect(logged).toEqual({ selected: 3, removed: 3, failed: 0, bytesFreed });
    expect(safetyInfo.mock.calls.some(([message]) => message === 'Pruned old Codex state backups')).toBe(false);
  });

  it('with keep-3 off runs the safety net alone and still keeps clean-up and archive backups', () => {
    const before = sizes();
    const result = pruneCodexBackupsAtStartup(false, dir);
    const after = sizes();
    const { removed, bytesFreed } = delta(before, after);

    expect([...after.keys()].sort()).toEqual([cleanup, archive, ...reconcile.slice(1)].sort());
    expect(result).toEqual({ selected: 1, removed: 1, failed: 0, bytesFreed });
    expect(removed).toBe(1);
    expect(policyInfo.mock.calls.some(([message]) => message === 'Codex backup keep-3 run')).toBe(false);
    const logged = safetyInfo.mock.calls.find(([message]) => message === 'Pruned old Codex state backups')?.[1];
    expect(logged).toMatchObject({ removed: 1, failed: 0, bytesFreed });
  });

  it('keeps links and non-regular files in the combined path', () => {
    writeFileSync(join(dir, 'external.sqlite'), 'x');
    symlinkSync(join(dir, 'external.sqlite'), join(dir, 'state_5-before-rollout-reconcile-20260109T000000000Z.sqlite'));

    const result = pruneCodexBackupsAtStartup(true, dir);

    expect(result.removed).toBe(3);
    expect(readdirSync(dir)).toContain('state_5-before-rollout-reconcile-20260109T000000000Z.sqlite');
    expect(readdirSync(dir)).toContain('external.sqlite');
  });
});
