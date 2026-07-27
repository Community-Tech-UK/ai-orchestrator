/**
 * SyncHandler allowlist behaviour.
 *
 * Regression coverage for LT-010: the worker built its SyncHandler from
 * `config.workingDirectories` only, so the sync tools rejected the very
 * file-transfer roots `upload_to_node` accepts — "Path outside allowed roots"
 * for a root the node explicitly designates for transfers. Reads and writes are
 * now separated so a read-only root is refused *as read-only*.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SyncHandler } from './sync-handler';

let root: string;
let workingDir: string;
let writableTransferRoot: string;
let readOnlyTransferRoot: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aio-sync-handler-'));
  workingDir = path.join(root, 'work');
  writableTransferRoot = path.join(root, 'scratch');
  readOnlyTransferRoot = path.join(root, 'downloads');
  for (const dir of [workingDir, writableTransferRoot, readOnlyTransferRoot]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path.join(readOnlyTransferRoot, 'report.txt'), 'hello');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeHandler(): SyncHandler {
  return new SyncHandler({
    readRoots: [workingDir, writableTransferRoot, readOnlyTransferRoot],
    writeRoots: [workingDir, writableTransferRoot],
  });
}

describe('SyncHandler roots (LT-010)', () => {
  it('scans a writable file-transfer root that is not a working directory', async () => {
    // The exact rejection reported against the live windows-pc worker.
    await expect(makeHandler().scanDirectory({ path: writableTransferRoot })).resolves.toBeDefined();
  });

  it('scans a read-only file-transfer root', async () => {
    await expect(makeHandler().scanDirectory({ path: readOnlyTransferRoot })).resolves.toBeDefined();
  });

  it('refuses a write into a read-only root AS read-only, not as an unknown path', async () => {
    await expect(
      makeHandler().deleteFile({ path: path.join(readOnlyTransferRoot, 'report.txt') }),
    ).rejects.toThrow(/read-only root/);
  });

  it('still refuses a path outside every root', async () => {
    const outside = path.join(root, 'elsewhere', 'secret.txt');
    await expect(makeHandler().scanDirectory({ path: outside })).rejects.toThrow(
      /outside allowed roots/,
    );
    await expect(makeHandler().deleteFile({ path: outside })).rejects.toThrow(
      /outside allowed roots/,
    );
  });

  it('permits a write inside a writable transfer root', async () => {
    const target = path.join(writableTransferRoot, 'gone.txt');
    writeFileSync(target, 'bye');
    await expect(makeHandler().deleteFile({ path: target })).resolves.toEqual({ ok: true });
  });

  it('keeps the legacy single-allowlist constructor behaving as read+write', async () => {
    const handler = new SyncHandler([workingDir]);
    await expect(handler.scanDirectory({ path: workingDir })).resolves.toBeDefined();
    await expect(handler.scanDirectory({ path: writableTransferRoot })).rejects.toThrow(
      /outside allowed roots/,
    );
  });
});
