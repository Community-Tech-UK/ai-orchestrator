/**
 * Heap snapshot diagnostic.
 *
 * Exists because the main process reached a 3.1-3.5 GB post-GC floor with no
 * way to attribute it: the app ships without `--inspect`, so there was no way
 * to ask V8 what was actually retained and every diagnosis was inference.
 * Writing a real `.heapsnapshot` makes the next investigation evidence-based —
 * load the file into Chrome DevTools > Memory and read the dominator tree.
 *
 * Snapshotting is deliberately manual. It pauses the isolate for the duration
 * (seconds, at multi-GB heaps) and writes a file roughly the size of the heap,
 * so it must never be wired to an automatic trigger.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as v8 from 'node:v8';
import { getLogger } from '../logging/logger';

const logger = getLogger('HeapSnapshot');

export interface HeapSnapshotResult {
  filePath: string;
  fileSizeBytes: number;
  durationMs: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  rssBytes: number;
}

/** Space-by-space heap breakdown; cheap enough to call any time. */
export interface HeapUsageSummary {
  heapUsedBytes: number;
  heapTotalBytes: number;
  heapLimitBytes: number;
  externalBytes: number;
  rssBytes: number;
  arrayBuffersBytes: number;
  spaces: { name: string; sizeBytes: number; usedBytes: number; availableBytes: number }[];
}

/**
 * Read current heap usage without pausing the isolate.
 * Use this first — it often localises the problem (e.g. `old_space` dominating
 * means retained JS objects, not native or external memory) before paying for a
 * full snapshot.
 */
export function getHeapUsageSummary(): HeapUsageSummary {
  const usage = process.memoryUsage();
  const stats = v8.getHeapStatistics();

  return {
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    heapLimitBytes: stats.heap_size_limit,
    externalBytes: usage.external,
    rssBytes: usage.rss,
    arrayBuffersBytes: usage.arrayBuffers,
    spaces: v8.getHeapSpaceStatistics().map((s) => ({
      name: s.space_name,
      sizeBytes: s.space_size,
      usedBytes: s.space_used_size,
      availableBytes: s.space_available_size,
    })),
  };
}

/**
 * Pick a non-colliding snapshot path.
 *
 * Date-stamped so several snapshots across a long session sort chronologically,
 * with a numeric suffix for same-millisecond writes — losing an earlier
 * snapshot to a name collision would destroy the evidence this exists to
 * capture. Exported so the collision behaviour is testable without paying for a
 * real multi-second snapshot write.
 */
export function nextSnapshotPath(directory: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let filePath = path.join(directory, `heap-${stamp}.heapsnapshot`);
  for (let n = 2; fs.existsSync(filePath); n++) {
    filePath = path.join(directory, `heap-${stamp}-${n}.heapsnapshot`);
  }
  return filePath;
}

/**
 * Write a V8 heap snapshot into `directory`.
 *
 * @param directory destination directory; created if absent
 * @returns the written path plus the heap stats captured at write time
 */
export function writeHeapSnapshot(directory: string): HeapSnapshotResult {
  fs.mkdirSync(directory, { recursive: true });

  const filePath = nextSnapshotPath(directory);

  const usageBefore = process.memoryUsage();
  const startedAt = Date.now();

  // Synchronous and isolate-pausing by design — see the file header.
  v8.writeHeapSnapshot(filePath);

  const durationMs = Date.now() - startedAt;
  const fileSizeBytes = fs.statSync(filePath).size;

  logger.warn('Heap snapshot written', {
    filePath,
    fileSizeMB: Math.round((fileSizeBytes / (1024 * 1024)) * 10) / 10,
    durationMs,
    heapUsedMB: Math.round(usageBefore.heapUsed / (1024 * 1024)),
  });

  return {
    filePath,
    fileSizeBytes,
    durationMs,
    heapUsedBytes: usageBefore.heapUsed,
    heapTotalBytes: usageBefore.heapTotal,
    externalBytes: usageBefore.external,
    rssBytes: usageBefore.rss,
  };
}
