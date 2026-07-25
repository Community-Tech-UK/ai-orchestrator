import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeHeapSnapshot } from './heap-snapshot';

describe('writeHeapSnapshot slow smoke', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heap-snapshot-e2e-'));
    dirs.push(dir);
    return dir;
  }

  // Exactly one real snapshot write lives in the suite. The isolated slow tier
  // keeps its size independent of the normal unit shard's accumulated heap.
  it('creates the directory and writes a loadable .heapsnapshot', { timeout: 30_000 }, () => {
    const dir = path.join(tempDir(), 'nested', 'diagnostics');

    const result = writeHeapSnapshot(dir);

    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(result.filePath.endsWith('.heapsnapshot')).toBe(true);
    expect(result.fileSizeBytes).toBeGreaterThan(0);
    expect(result.heapUsedBytes).toBeGreaterThan(0);

    // Chrome DevTools requires a JSON document. Read only the prefix: a real
    // diagnostic snapshot can exceed Node's maximum single-string length.
    const descriptor = fs.openSync(result.filePath, 'r');
    try {
      const buffer = Buffer.alloc(32);
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      expect(buffer.toString('utf8', 0, bytesRead).trimStart().startsWith('{')).toBe(true);
    } finally {
      fs.closeSync(descriptor);
    }
  });
});
