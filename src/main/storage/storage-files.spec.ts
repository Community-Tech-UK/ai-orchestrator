import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listStorageFiles, removeStorageFilesWithReceipt } from './storage-files';

describe('storage file hard-link receipts', () => {
  let root: string;
  beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'storage-link-receipt-'))); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('does not treat an external change after the first selected unlink as our own transition', async () => {
    await fs.writeFile(join(root, 'first'), Buffer.alloc(1024));
    await fs.link(join(root, 'first'), join(root, 'second'));
    const files = (await listStorageFiles(root)).map((file, index) => ({ ...file, instanceId: String(index) }));
    let visits = 0;
    const { writeFileSync } = await import('node:fs');
    await expect(removeStorageFilesWithReceipt(files, [root], () => {
      if (++visits === 2) writeFileSync(join(root, 'second'), 'external edit');
      return new Set();
    })).rejects.toThrow(/Review again/);
    expect(await fs.readFile(join(root, 'second'), 'utf8')).toBe('external edit');
  });

  it('retains a symlink replacement without following its content', async () => {
    const selected = join(root, 'selected');
    await fs.mkdir(selected);
    await fs.writeFile(join(selected, 'first'), Buffer.alloc(1024));
    const files = await listStorageFiles(selected);
    const retained = join(root, 'retained');
    await fs.rename(join(selected, 'first'), retained);
    await fs.symlink(retained, join(selected, 'first'));
    await expect(removeStorageFilesWithReceipt(files, [selected], () => new Set())).rejects.toThrow(/Review again/);
    expect((await fs.lstat(join(selected, 'first'))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(retained)).size).toBe(1024);
  });

  it.each([false, true])('credits content once only when the final selected link is removed (retained=%s)', async retained => {
    const selected = join(root, 'selected');
    await fs.mkdir(selected);
    await fs.writeFile(join(selected, 'first'), Buffer.alloc(1024));
    await fs.link(join(selected, 'first'), join(selected, 'second'));
    if (retained) await fs.link(join(selected, 'first'), join(root, 'retained'));
    const files = await listStorageFiles(selected);
    expect(await removeStorageFilesWithReceipt(files, [selected], () => new Set()))
      .toEqual({ removed: 2, bytesFreed: retained ? 0 : 1024 });
    expect(await fs.readdir(selected)).toEqual([]);
    if (retained) expect((await fs.lstat(join(root, 'retained'))).size).toBe(1024);
  });
});
