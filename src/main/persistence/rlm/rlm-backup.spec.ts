import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { backupDatabase } from './rlm-backup';

describe('RLM backup', () => {
  const roots: string[] = [];

  afterEach(() => {
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it('waits for the asynchronous SQLite backup before measuring and returning it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rlm-backup-'));
    roots.push(root);
    const targetPath = join(root, 'backup', 'rlm.db');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const backup = vi.fn(async (destination: string) => {
      await blocked;
      writeFileSync(destination, 'sqlite backup bytes');
    });
    const driver = { backup } as unknown as SqliteDriver;

    let settled = false;
    const pending = backupDatabase(driver, join(root, 'content'), targetPath, { includeContent: false })
      .then((result) => { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await expect(pending).resolves.toMatchObject({
      dbBackupPath: targetPath,
      dbSizeBytes: 19,
    });
    expect(backup).toHaveBeenCalledWith(targetPath);
  });
});
