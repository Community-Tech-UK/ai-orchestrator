import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pruneOldBackups } from './rlm-backup-retention';

const roots: string[] = [];
const removalFailure = vi.hoisted(() => ({ suffix: null as string | null }));
const renameFailure = vi.hoisted(() => ({ suffix: null as string | null }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (removalFailure.suffix && String(args[0]).includes(removalFailure.suffix)) throw new Error('locked');
      return actual.rmSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (renameFailure.suffix && String(args[0]).endsWith(renameFailure.suffix)) throw new Error('locked');
      return actual.renameSync(...args);
    },
  };
});

describe('pruneOldBackups', () => {
  afterEach(() => {
    removalFailure.suffix = null;
    renameFailure.suffix = null;
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps the newest matching backup sets and removes only older maintenance siblings', () => {
    const directory = makeDirectory();
    const oldest = createBackupSet(directory, '20260710T120000000Z', 'old', [3, 2, 1, 4]);
    const middle = createBackupSet(directory, '20260711T120000000Z', 'middle', [5, 0, 0, 0]);
    const newest = createBackupSet(directory, '20260712T120000000Z', 'new', [6, 0, 0, 0]);
    const unrelated = path.join(directory, 'notes.txt');
    const unrelatedDirectory = path.join(directory, '.rlm-backup-prune-not-ours');
    fs.writeFileSync(unrelated, 'keep');
    fs.mkdirSync(unrelatedDirectory);
    fs.writeFileSync(path.join(unrelatedDirectory, 'notes.txt'), 'keep');

    const result = pruneOldBackups(directory, 2);

    expect(result).toEqual({ deleted: 1, bytesFreed: 10, failed: 0 });
    expect(fs.existsSync(oldest.db)).toBe(false);
    expect(fs.existsSync(oldest.wal)).toBe(false);
    expect(fs.existsSync(oldest.shm)).toBe(false);
    expect(fs.existsSync(oldest.content)).toBe(false);
    expect(fs.existsSync(middle.db)).toBe(true);
    expect(fs.existsSync(newest.db)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.existsSync(unrelatedDirectory)).toBe(true);
  });

  it('uses mtime ordering for a matching backup whose timestamp cannot be parsed', () => {
    const directory = makeDirectory();
    const malformed = createBackupSet(directory, 'not-a-timestamp', 'old', [3, 0, 0, 0]);
    const valid = createBackupSet(directory, '20260712T120000000Z', 'new', [5, 0, 0, 0]);
    fs.utimesSync(malformed.db, new Date(Date.UTC(2027, 0, 1)), new Date(Date.UTC(2027, 0, 1)));
    fs.utimesSync(valid.db, new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 0, 1)));

    const result = pruneOldBackups(directory, 1);

    expect(result).toEqual({ deleted: 1, bytesFreed: 5, failed: 0 });
    expect(fs.existsSync(malformed.db)).toBe(true);
    expect(fs.existsSync(valid.db)).toBe(false);
  });

  it('leaves a failed set in a retryable staging tombstone and continues pruning', () => {
    const directory = makeDirectory();
    const oldest = createBackupSet(directory, '20260710T120000000Z', 'old', [3, 2, 0, 0]);
    const middle = createBackupSet(directory, '20260711T120000000Z', 'middle', [4, 0, 0, 0]);
    createBackupSet(directory, '20260712T120000000Z', 'new', [5, 0, 0, 0]);
    removalFailure.suffix = '.rlm-backup-prune-rlm-maintenance-20260710';

    let result: ReturnType<typeof pruneOldBackups> | undefined;
    expect(() => { result = pruneOldBackups(directory, 1); }).not.toThrow();
    expect(result).toEqual({ deleted: 1, bytesFreed: 4, failed: 1 });
    expect(fs.existsSync(oldest.db)).toBe(false);
    expect(fs.existsSync(middle.db)).toBe(false);
    expect(fs.readdirSync(directory).some((entry) => entry.startsWith('.rlm-backup-prune-'))).toBe(true);

    removalFailure.suffix = null;
    expect(pruneOldBackups(directory, 1)).toEqual({ deleted: 1, bytesFreed: 5, failed: 0 });
    expect(fs.readdirSync(directory).some((entry) => entry.startsWith('.rlm-backup-prune-'))).toBe(false);
  });

  it('rolls back an incomplete staging attempt before it can split a backup set', () => {
    const directory = makeDirectory();
    const oldest = createBackupSet(directory, '20260710T120000000Z', 'old', [3, 2, 0, 0]);
    const middle = createBackupSet(directory, '20260711T120000000Z', 'middle', [4, 0, 0, 0]);
    createBackupSet(directory, '20260712T120000000Z', 'new', [5, 0, 0, 0]);
    renameFailure.suffix = path.basename(oldest.wal);

    const result = pruneOldBackups(directory, 1);

    expect(result).toEqual({ deleted: 1, bytesFreed: 4, failed: 1 });
    expect(fs.existsSync(oldest.db)).toBe(true);
    expect(fs.existsSync(oldest.wal)).toBe(true);
    expect(fs.readdirSync(directory).some((entry) => entry.startsWith('.rlm-backup-prune-'))).toBe(false);
    expect(fs.existsSync(middle.db)).toBe(false);
  });

  function makeDirectory(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-rlm-backups-'));
    roots.push(root);
    return root;
  }
});

function createBackupSet(
  directory: string,
  timestamp: string,
  operationId: string,
  sizes: [number, number, number, number],
) {
  const stem = path.join(directory, `rlm-maintenance-${timestamp}-${operationId}`);
  const db = `${stem}.db`;
  const wal = `${db}-wal`;
  const shm = `${db}-shm`;
  const content = `${stem}_content`;
  writeSizedFile(db, sizes[0]);
  if (sizes[1] > 0) writeSizedFile(wal, sizes[1]);
  if (sizes[2] > 0) writeSizedFile(shm, sizes[2]);
  if (sizes[3] > 0) {
    fs.mkdirSync(content);
    writeSizedFile(path.join(content, 'section.txt'), sizes[3]);
  }
  return { db, wal, shm, content };
}

function writeSizedFile(file: string, size: number): void {
  fs.writeFileSync(file, 'x'.repeat(size));
}
