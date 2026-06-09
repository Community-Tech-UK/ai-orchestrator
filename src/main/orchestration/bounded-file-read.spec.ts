import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readUtf8FileHead,
  readUtf8FileHeadSync,
  readUtf8FileTail,
} from './bounded-file-read';

describe('bounded file reads', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bounded-file-read-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads only the leading text window for async callers', async () => {
    const file = join(dir, 'large.txt');
    writeFileSync(file, `${'a'.repeat(4096)}TAIL`);

    const result = await readUtf8FileHead(file, 128);

    expect(result.text).toHaveLength(128);
    expect(result.text).toBe('a'.repeat(128));
    expect(result.truncated).toBe(true);
    expect(result.sizeBytes).toBe(4100);
  });

  it('reads only the trailing text window for async callers', async () => {
    const file = join(dir, 'large-tail.txt');
    writeFileSync(file, `${'a'.repeat(4096)}TAIL`);

    const result = await readUtf8FileTail(file, 8);

    expect(result.text).toBe('aaaaTAIL');
    expect(result.truncated).toBe(true);
    expect(result.sizeBytes).toBe(4100);
  });

  it('reports untruncated small files', async () => {
    const file = join(dir, 'small.txt');
    writeFileSync(file, 'small');

    const result = await readUtf8FileHead(file, 128);

    expect(result.text).toBe('small');
    expect(result.truncated).toBe(false);
    expect(result.sizeBytes).toBe(5);
  });

  it('has a synchronous head reader for cold termination paths', () => {
    const file = join(dir, 'sync-large.txt');
    writeFileSync(file, 'x'.repeat(1024));

    const result = readUtf8FileHeadSync(file, 64);

    expect(result.text).toBe('x'.repeat(64));
    expect(result.truncated).toBe(true);
    expect(result.sizeBytes).toBe(1024);
  });
});
