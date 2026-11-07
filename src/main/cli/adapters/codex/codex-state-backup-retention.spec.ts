import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_AUTO_BACKUPS_KEEP,
  pruneAutoBackups,
  pruneCodexStateBackups,
  selectAutoBackupsToPrune,
} from './codex-state-backup-retention';

// The name codex-private-rollout-reconcile.ts (uniqueBackupPath) really writes.
const auto = (stamp: string, suffix?: number) =>
  `state_5-before-rollout-reconcile-${stamp}${suffix === undefined ? '' : `-${suffix}`}.sqlite`;

describe('selectAutoBackupsToPrune', () => {
  it('keeps the newest 3 automatic copies and returns the older ones, oldest first', () => {
    const names = Array.from({ length: 10 }, (_, i) => auto(`202601${String(i + 1).padStart(2, '0')}T000000000Z`));
    expect(selectAutoBackupsToPrune(names)).toEqual(names.slice(0, 7));
    expect(selectAutoBackupsToPrune(names, CODEX_AUTO_BACKUPS_KEEP)).toHaveLength(7);
  });

  it('orders -1 suffixes after the plain name of the same stamp', () => {
    const names = [auto('20260101T000000000Z', 1), auto('20260101T000000000Z'), auto('20260101T000000000Z', 2)];
    expect(selectAutoBackupsToPrune(names, 1)).toEqual([
      auto('20260101T000000000Z'),
      auto('20260101T000000000Z', 1),
    ]);
  });

  it('selects only reconcile copies from a folder shaped like today\'s, never clean-up or archive copies', () => {
    const cleanup = Array.from({ length: 5 }, (_, i) => `state_5-before-aio-cleanup-2026071${i}T000000000Z.sqlite`);
    const archive = ['state_5-before-aio-archive-20260711T000000000Z.sqlite'];
    const reconcile = Array.from({ length: 425 }, (_, i) => auto(`202607${String(10 + Math.floor(i / 24)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}0000000Z`));
    const picked = selectAutoBackupsToPrune([...cleanup, ...archive, ...reconcile], 3);
    expect(picked).toHaveLength(422);
    expect(picked.every(name => reconcile.includes(name))).toBe(true);
  });

  it('ignores unrelated names and picks nothing below the keep count', () => {
    expect(selectAutoBackupsToPrune(['state_5.sqlite', 'notes.txt', 'state_5-before-rollout-reconcile-20260101T000000000Z.sqlite'], 3)).toEqual([]);
    expect(selectAutoBackupsToPrune([auto('20260101T000000000Z'), 'other.sqlite'], 5)).toEqual([]);
  });
});

describe('pruneAutoBackups', () => {
  it('removes only the displaced copy in the steady state', () => {
    const names = [auto('20260101T000000000Z'), auto('20260102T000000000Z'), auto('20260103T000000000Z'), auto('20260104T000000000Z')];
    const remove = vi.fn();
    const result = pruneAutoBackups('/backups', { list: () => names, remove });
    expect(result).toEqual({ selected: 1, removed: 1, failed: 0 });
    expect(remove).toHaveBeenCalledExactlyOnceWith('/backups', auto('20260101T000000000Z'));
  });

  it('removes none and logs once when the tripwire count is exceeded', () => {
    const names = Array.from({ length: 10 }, (_, i) => auto(`202601${String(i + 1).padStart(2, '0')}T000000000Z`));
    const remove = vi.fn();
    const result = pruneAutoBackups('/backups', { list: () => names, remove });
    expect(result).toEqual({ selected: 7, removed: 0, failed: 0 });
    expect(remove).not.toHaveBeenCalled();
  });

  it('logs and skips a failing remove without throwing', () => {
    const names = [auto('20260101T000000000Z'), auto('20260102T000000000Z'), auto('20260103T000000000Z'), auto('20260104T000000000Z')];
    const remove = vi.fn(() => { throw new Error('locked'); });
    const result = pruneAutoBackups('/backups', { list: () => names, remove });
    expect(result).toEqual({ selected: 1, removed: 0, failed: 1 });
    expect(remove).toHaveBeenCalledOnce();
  });

  it('never touches clean-up or archive copies', () => {
    const names = ['state_5-before-aio-cleanup-20260101T000000000Z.sqlite',
      'state_5-before-aio-archive-20260101T000000000Z.sqlite', auto('20260102T000000000Z')];
    const remove = vi.fn();
    expect(pruneAutoBackups('/backups', { list: () => names, remove })).toEqual({ selected: 0, removed: 0, failed: 0 });
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('keep-3 on the copies Harness really writes', () => {
  it('keeps the newest three and leaves clean-up, archive and unrelated files', () => {
    const names = [
      'state_5-before-aio-cleanup-20260101T000000000Z.sqlite',
      'state_5-before-aio-archive-20260102T000000000Z.sqlite',
      ...Array.from({ length: 5 }, (_, i) => auto(`2026010${i + 1}T000000000Z`)),
      auto('20260105T000000000Z', 1),
      'state_5.sqlite',
    ];
    const remove = vi.fn();
    expect(pruneAutoBackups('/backups', { list: () => names, remove })).toEqual({ selected: 3, removed: 3, failed: 0 });
    expect(remove.mock.calls.map(([, name]) => name)).toEqual([auto('20260101T000000000Z'), auto('20260102T000000000Z'), auto('20260103T000000000Z')]);
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 22, 12);

describe('pruneCodexStateBackups', () => {
  let backupDir: string;

  beforeEach(() => {
    backupDir = mkdtempSync(join(tmpdir(), 'codex-backup-retention-'));
  });

  afterEach(() => {
    rmSync(backupDir, { recursive: true, force: true });
  });

  function writeBackup(name: string, ageDays: number): void {
    const filePath = join(backupDir, name);
    writeFileSync(filePath, 'sqlite');
    const mtime = new Date(NOW - ageDays * DAY_MS);
    utimesSync(filePath, mtime, mtime);
  }

  it('keeps the newest backups and deletes older ones past the minimum age', () => {
    for (let day = 1; day <= 10; day++) {
      writeBackup(`state_5-before-rollout-reconcile-day${day}.sqlite`, day * 3);
    }

    const result = pruneCodexStateBackups({ backupDir, keep: 3, minAgeMs: 7 * DAY_MS, now: () => NOW });

    expect(result).toEqual({ removed: 7, failed: 0, bytesFreed: 7 * 'sqlite'.length });
    expect(readdirSync(backupDir).sort()).toEqual([
      'state_5-before-rollout-reconcile-day1.sqlite',
      'state_5-before-rollout-reconcile-day2.sqlite',
      'state_5-before-rollout-reconcile-day3.sqlite',
    ]);
  });

  it('keeps recent backups even beyond the keep count', () => {
    for (let index = 0; index < 6; index++) {
      writeBackup(`state_5-before-rollout-reconcile-${index}.sqlite`, 1);
    }

    expect(pruneCodexStateBackups({ backupDir, keep: 2, minAgeMs: 7 * DAY_MS, now: () => NOW })).toEqual({ removed: 0, failed: 0, bytesFreed: 0 });
    expect(readdirSync(backupDir)).toHaveLength(6);
  });

  it('leaves unrelated names, clean-up and archive backups alone', () => {
    writeBackup('notes.txt', 30);
    writeBackup('state_5.sqlite', 30);
    writeBackup('state_5-before-aio-cleanup-old.sqlite', 30);
    writeBackup('state_5-before-aio-archive-old.sqlite', 30);
    writeBackup('state_5-before-rollout-reconcile-old.sqlite', 30);

    expect(pruneCodexStateBackups({ backupDir, keep: 0, minAgeMs: DAY_MS, now: () => NOW })).toEqual({ removed: 1, failed: 0, bytesFreed: 'sqlite'.length });
    expect(readdirSync(backupDir).sort()).toEqual([
      'notes.txt',
      'state_5-before-aio-archive-old.sqlite',
      'state_5-before-aio-cleanup-old.sqlite',
      'state_5.sqlite',
    ]);
  });

  it('never removes clean-up or archive backups, whatever their age and count', () => {
    for (let index = 0; index < 6; index++) {
      writeBackup(`state_5-before-aio-cleanup-${index}.sqlite`, 30 + index);
      writeBackup(`state_5-before-aio-archive-${index}.sqlite`, 30 + index);
      writeBackup(`state_5-before-rollout-reconcile-${index}.sqlite`, 30 + index);
    }

    expect(pruneCodexStateBackups({ backupDir, keep: 2, minAgeMs: DAY_MS, now: () => NOW })).toEqual({ removed: 4, failed: 0, bytesFreed: 4 * 'sqlite'.length });
    const remaining = readdirSync(backupDir).sort();
    expect(remaining.filter((name) => name.includes('aio-cleanup') || name.includes('aio-archive'))).toHaveLength(12);
    expect(remaining.filter((name) => name.includes('rollout-reconcile'))).toEqual([
      'state_5-before-rollout-reconcile-0.sqlite',
      'state_5-before-rollout-reconcile-1.sqlite',
    ]);
  });

  it('leaves links alone', () => {
    writeBackup('external.sqlite', 30);
    symlinkSync(join(backupDir, 'external.sqlite'), join(backupDir, 'state_5-before-rollout-reconcile-link.sqlite'));

    expect(pruneCodexStateBackups({ backupDir, keep: 0, minAgeMs: DAY_MS, now: () => NOW })).toEqual({ removed: 0, failed: 0, bytesFreed: 0 });
    expect(readdirSync(backupDir).sort()).toEqual(['external.sqlite', 'state_5-before-rollout-reconcile-link.sqlite']);
  });

  it('does not follow a linked backup directory or remove files in its target', () => {
    const names = Array.from({ length: 6 }, (_, index) => `state_5-before-rollout-reconcile-${index}.sqlite`);
    for (const name of names) writeBackup(name, 30);
    const linkedDir = join(backupDir, 'backups-link');
    symlinkSync(backupDir, linkedDir, 'dir');

    expect(pruneCodexStateBackups({ backupDir: linkedDir, now: () => NOW })).toEqual({ removed: 0, failed: 0, bytesFreed: 0 });
    expect(lstatSync(linkedDir).isSymbolicLink()).toBe(true);
    expect(readdirSync(backupDir).sort()).toEqual(['backups-link', ...names].sort());
    for (const name of names) expect(readFileSync(join(backupDir, name), 'utf8')).toBe('sqlite');
  });

  it('returns zero and preserves a regular file used as the backup directory', () => {
    const file = join(backupDir, 'backups-file');
    writeFileSync(file, 'keep');

    expect(pruneCodexStateBackups({ backupDir: file, now: () => NOW })).toEqual({ removed: 0, failed: 0, bytesFreed: 0 });
    expect(readFileSync(file, 'utf8')).toBe('keep');
  });

  it('returns zero when the backups folder does not exist', () => {
    expect(pruneCodexStateBackups({ backupDir: join(backupDir, 'missing'), now: () => NOW })).toEqual({ removed: 0, failed: 0, bytesFreed: 0 });
  });
});
