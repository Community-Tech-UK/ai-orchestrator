import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getHeapUsageSummary, nextSnapshotPath, writeHeapSnapshot } from './heap-snapshot';

describe('getHeapUsageSummary', () => {
  it('reports heap, limit and per-space usage', () => {
    const summary = getHeapUsageSummary();

    expect(summary.heapUsedBytes).toBeGreaterThan(0);
    expect(summary.heapLimitBytes).toBeGreaterThan(summary.heapUsedBytes);
    expect(summary.spaces.length).toBeGreaterThan(0);

    // old_space is the one that matters for retained JS objects — the shape of
    // problem that drove this diagnostic in the first place.
    expect(summary.spaces.some((s) => s.name === 'old_space')).toBe(true);
  });
});

describe('writeHeapSnapshot', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heap-snapshot-spec-'));
    dirs.push(dir);
    return dir;
  }

  // Exactly one real snapshot write lives in this file. Each pauses the isolate
  // and writes a file the size of the heap, so extra ones make the suite
  // load-sensitive rather than testing anything new.
  it('creates the directory and writes a loadable .heapsnapshot', { timeout: 30_000 }, () => {
    const dir = path.join(tempDir(), 'nested', 'diagnostics');

    const result = writeHeapSnapshot(dir);

    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(result.filePath.endsWith('.heapsnapshot')).toBe(true);
    expect(result.fileSizeBytes).toBeGreaterThan(0);
    expect(result.heapUsedBytes).toBeGreaterThan(0);

    // Chrome DevTools requires a JSON document; a truncated write would be
    // useless precisely when it is most needed.
    const head = fs.readFileSync(result.filePath, 'utf8').slice(0, 32);
    expect(head.trimStart().startsWith('{')).toBe(true);
  });

  it('never overwrites a previous snapshot', () => {
    // Deliberately does NOT write two real snapshots: at a multi-GB heap each
    // write pauses the isolate for seconds, which made this test fail purely
    // from load when the full suite ran in parallel.
    const dir = tempDir();
    const at = new Date('2026-07-21T22:30:00.000Z');

    const first = nextSnapshotPath(dir, at);
    fs.writeFileSync(first, '{}');
    const second = nextSnapshotPath(dir, at);

    expect(second).not.toBe(first);
    expect(path.basename(second)).toContain('-2.heapsnapshot');
  });
});
