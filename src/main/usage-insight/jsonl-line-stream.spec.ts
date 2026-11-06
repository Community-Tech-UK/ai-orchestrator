import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { streamLines } from './jsonl-line-stream';

describe('streamLines', () => {
  let directory: string;
  let file: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jsonl-lines-'));
    file = join(directory, 'log.jsonl');
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  async function read(options: { start?: number; chunkBytes?: number; maxLineBytes?: number; signal?: AbortSignal } = {}) {
    const lines: { text: string | null; end: number }[] = [];
    await streamLines(file, {
      start: options.start ?? 0,
      chunkBytes: options.chunkBytes ?? 1024,
      maxLineBytes: options.maxLineBytes ?? 1024,
      signal: options.signal,
      onLine: (line, end) => lines.push({ text: line === null ? null : line.toString('utf8'), end }),
    });
    return lines;
  }

  it('hands over each line with the offset just after its newline', async () => {
    writeFileSync(file, 'a\nbb\nccc\n');
    expect(await read({ chunkBytes: 4 })).toEqual([
      { text: 'a', end: 2 },
      { text: 'bb', end: 5 },
      { text: 'ccc', end: 9 },
    ]);
  });

  it('gives the same lines whatever the chunk size', async () => {
    writeFileSync(file, 'first line\nsecond\n\nfourth line here\n');
    const expected = await read({ chunkBytes: 1024 });
    for (const chunkBytes of [1, 2, 3, 7, 16]) {
      expect(await read({ chunkBytes })).toEqual(expected);
    }
  });

  it('leaves a final line without a newline for the next read', async () => {
    writeFileSync(file, 'done\nhalf-writ');
    expect(await read()).toEqual([{ text: 'done', end: 5 }]);
  });

  it('carries on from an offset', async () => {
    writeFileSync(file, 'a\nbb\nccc\n');
    expect(await read({ start: 2 })).toEqual([{ text: 'bb', end: 5 }, { text: 'ccc', end: 9 }]);
  });

  it('never splits a multi-byte character across chunks', async () => {
    writeFileSync(file, 'café ☕\n');
    expect(await read({ chunkBytes: 1 })).toEqual([{ text: 'café ☕', end: Buffer.byteLength('café ☕\n') }]);
  });

  it('skips a line longer than the limit and carries on with the next', async () => {
    writeFileSync(file, `ok\n${'z'.repeat(40)}\nfine\n`);
    for (const chunkBytes of [3, 1024]) {
      expect(await read({ chunkBytes, maxLineBytes: 10 })).toEqual([
        { text: 'ok', end: 3 },
        { text: null, end: 3 + 40 + 1 },
        { text: 'fine', end: 3 + 40 + 1 + 5 },
      ]);
    }
  });

  it('does nothing for an empty file', async () => {
    writeFileSync(file, '');
    expect(await read()).toEqual([]);
  });

  it('stops when asked to', async () => {
    writeFileSync(file, 'one\ntwo\nthree\nfour\n');
    const controller = new AbortController();
    const seen: string[] = [];
    await streamLines(file, {
      start: 0,
      chunkBytes: 4,
      maxLineBytes: 1024,
      signal: controller.signal,
      onLine: (line) => {
        seen.push(line?.toString('utf8') ?? '');
        controller.abort();
      },
    });
    expect(seen).toEqual(['one']);
  });

  it('fails for a file that is not there', async () => {
    await expect(read()).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
