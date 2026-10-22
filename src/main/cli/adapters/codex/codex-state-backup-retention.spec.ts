import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneCodexStateBackups } from './codex-state-backup-retention';

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

    const removed = pruneCodexStateBackups({ backupDir, keep: 3, minAgeMs: 7 * DAY_MS, now: () => NOW });

    expect(removed).toBe(7);
    expect(readdirSync(backupDir).sort()).toEqual([
      'state_5-before-rollout-reconcile-day1.sqlite',
      'state_5-before-rollout-reconcile-day2.sqlite',
      'state_5-before-rollout-reconcile-day3.sqlite',
    ]);
  });

  it('keeps recent backups even beyond the keep count', () => {
    for (let index = 0; index < 6; index++) {
      writeBackup(`state_5-before-aio-cleanup-${index}.sqlite`, 1);
    }

    expect(pruneCodexStateBackups({ backupDir, keep: 2, minAgeMs: 7 * DAY_MS, now: () => NOW })).toBe(0);
    expect(readdirSync(backupDir)).toHaveLength(6);
  });

  it('leaves files that are not Codex state backups alone', () => {
    writeBackup('notes.txt', 30);
    writeBackup('state_5.sqlite', 30);
    writeBackup('state_5-before-aio-archive-old.sqlite', 30);

    expect(pruneCodexStateBackups({ backupDir, keep: 0, minAgeMs: DAY_MS, now: () => NOW })).toBe(1);
    expect(readdirSync(backupDir).sort()).toEqual(['notes.txt', 'state_5.sqlite']);
  });

  it('returns 0 when the backups folder does not exist', () => {
    expect(pruneCodexStateBackups({ backupDir: join(backupDir, 'missing'), now: () => NOW })).toBe(0);
  });
});
