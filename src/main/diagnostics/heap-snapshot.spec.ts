import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getHeapUsageSummary, nextSnapshotPath } from './heap-snapshot';

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

describe('nextSnapshotPath', () => {
  it('never overwrites a previous snapshot', () => {
    // A real snapshot write is isolated in heap-snapshot.e2e.spec.ts. Keeping
    // it out of the normal unit shard prevents the snapshot size from depending
    // on the accumulated heap of thousands of preceding tests.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heap-snapshot-spec-'));
    const at = new Date('2026-07-21T22:30:00.000Z');

    try {
      const first = nextSnapshotPath(dir, at);
      fs.writeFileSync(first, '{}');
      const second = nextSnapshotPath(dir, at);

      expect(second).not.toBe(first);
      expect(path.basename(second)).toContain('-2.heapsnapshot');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
