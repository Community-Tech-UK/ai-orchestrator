import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { NodeFilesystemHandler } from './node-filesystem-handler';

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('NodeFilesystemHandler streamed chunks (real filesystem)', () => {
  let root: string;
  let handler: NodeFilesystemHandler;

  beforeEach(() => {
    // realpath: macOS tmpdir lives behind a /var → /private/var symlink.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'aio-fs-chunks-')));
    handler = new NodeFilesystemHandler([root]);
  });

  it('accumulates sequential chunks in a partial file and commits with a hash on done', async () => {
    const target = join(root, 'incoming', 'video.bin');
    const content = Buffer.from('0123456789abcdef');

    const first = await handler.writeFileChunk({
      path: target,
      data: content.subarray(0, 10).toString('base64'),
      offset: 0,
      totalSize: content.length,
      done: false,
    });
    expect(first).toMatchObject({ ok: true, bytesWritten: 10, committed: false });
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.aio-partial`)).toBe(true);

    const second = await handler.writeFileChunk({
      path: target,
      data: content.subarray(10).toString('base64'),
      offset: 10,
      totalSize: content.length,
      done: true,
    });
    expect(second).toMatchObject({
      ok: true,
      committed: true,
      size: content.length,
      sha256: sha256(content),
    });
    expect(readFileSync(target)).toEqual(content);
    expect(existsSync(`${target}.aio-partial`)).toBe(false);
  });

  it('rejects an out-of-order chunk and clears the partial so a restart is clean', async () => {
    const target = join(root, 'gap.bin');
    await handler.writeFileChunk({
      path: target,
      data: Buffer.from('aaaa').toString('base64'),
      offset: 0,
      totalSize: 12,
      done: false,
    });

    await expect(handler.writeFileChunk({
      path: target,
      data: Buffer.from('cccc').toString('base64'),
      offset: 8,
      totalSize: 12,
      done: false,
    })).rejects.toThrow(/EIO: chunk offset 8/);
    expect(existsSync(`${target}.aio-partial`)).toBe(false);
  });

  it('refuses streamed writes outside the writable roots', async () => {
    await expect(handler.writeFileChunk({
      path: join(tmpdir(), 'aio-outside', 'escape.bin'),
      data: Buffer.from('x').toString('base64'),
      offset: 0,
      totalSize: 1,
      done: true,
    })).rejects.toThrow(/EOUTOFSCOPE/);
  });

  it('reads a file back in offset chunks with a correct eof marker', async () => {
    const source = join(root, 'big.bin');
    const content = Buffer.from('the quick brown fox');
    writeFileSync(source, content);

    const first = await handler.readFileChunk({ path: source, offset: 0, length: 10 });
    expect(Buffer.from(first.data, 'base64')).toEqual(content.subarray(0, 10));
    expect(first).toMatchObject({ bytesRead: 10, size: content.length, eof: false });

    const second = await handler.readFileChunk({ path: source, offset: 10, length: 100 });
    expect(Buffer.from(second.data, 'base64')).toEqual(content.subarray(10));
    expect(second.eof).toBe(true);
  });

  it('refuses chunked reads of restricted filenames', async () => {
    const secret = join(root, 'id_rsa');
    writeFileSync(secret, 'private key material placeholder');

    await expect(handler.readFileChunk({ path: secret, offset: 0, length: 8 }))
      .rejects.toThrow(/restricted file/);
  });
});
