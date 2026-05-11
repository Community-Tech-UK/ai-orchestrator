/**
 * SessionDiffTracker — captures file content baselines and computes line-level
 * diffs to accumulate session-wide change stats (added/deleted line counts).
 *
 * One tracker is created per active instance. The lifecycle is:
 *   1. Agent tool calls trigger captureBaseline() for each file it reads/writes.
 *   2. At the end of a turn computeDiff() is called — it diffs each baseline
 *      against the current on-disk content, accumulates the results, then clears
 *      the per-turn baselines ready for the next turn.
 *   3. reset() zeroes all accumulated stats (used when starting a fresh session).
 */

import * as fs from 'fs';
import * as path from 'path';
import { diffLines } from 'diff';
import { getLogger } from '../logging/logger';
import type { FileDiffEntry, SessionDiffStats } from '../../shared/types/instance.types';
import { isArtifactPath } from '../../shared/utils/artifact-extensions';

const logger = getLogger('SessionDiffTracker');

/** Files larger than this are skipped (10 MB). */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/** How many bytes to inspect for null bytes when detecting binary files. */
const BINARY_DETECT_BYTES = 8 * 1024;

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Read raw file content.  Returns:
 *   - `null`   — file is binary (null byte found in first BINARY_DETECT_BYTES)
 *   - `''`     — file does not exist
 *   - `string` — file text content
 *
 * Files larger than MAX_FILE_SIZE_BYTES are skipped (returns undefined, caller
 * must handle the skip).
 */
function readFileContent(filePath: string): string | null | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    // File does not exist — treat as empty baseline.
    return '';
  }

  if (stat.size > MAX_FILE_SIZE_BYTES) {
    return undefined; // sentinel: skip
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    // Binary detection: read up to BINARY_DETECT_BYTES and look for null byte.
    const bytesToCheck = Math.min(stat.size, BINARY_DETECT_BYTES);
    if (bytesToCheck > 0) {
      const sample = Buffer.alloc(bytesToCheck);
      fs.readSync(fd, sample, 0, bytesToCheck, 0);
      if (sample.includes(0)) {
        return null; // binary
      }
    }

    // Read full content as text.
    const buf = Buffer.alloc(stat.size);
    fs.readSync(fd, buf, 0, stat.size, 0);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// ============================================================================
// SessionDiffTracker
// ============================================================================

/**
 * Tracks per-turn file baselines and accumulates line-level diff stats across
 * all turns in a session.
 */
export class SessionDiffTracker {
  /**
   * Baseline content captured at the start of each turn.
   * Key: absolute file path.
   * Value: text content (`null` = binary file marker).
   */
  private baselines = new Map<string, string | null>();

  /** Accumulated diff stats for the entire session. */
  private stats: SessionDiffStats = {
    totalAdded: 0,
    totalDeleted: 0,
    files: {},
  };

  constructor(private readonly workingDirectory: string) {}

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Capture the baseline content of `filePath` for the current turn.
   *
   * Rules:
   * - A file is only captured ONCE per turn (subsequent calls for the same
   *   path within the same turn are ignored).
   * - Paths outside `workingDirectory` are silently ignored.
   * - Non-existent files get an empty-string baseline.
   * - Binary files get a `null` marker.
   * - Files larger than 10 MB are skipped.
   *
   * `filePath` may be absolute or relative; relative paths are resolved
   * against `workingDirectory`.
   */
  captureBaseline(filePath: string): void {
    const absolute = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.workingDirectory, filePath);

    // Files outside the working directory are only tracked if they are
    // user-facing artifacts (documentation, generated assets, exports).
    // Agents sometimes drop these into /tmp or absolute paths, and we want
    // them to surface in the chat UI so the user can find them. Code files
    // outside cwd stay ignored to avoid polluting per-session diff stats.
    const rel = path.relative(this.workingDirectory, absolute);
    const outsideCwd = rel.startsWith('..') || path.isAbsolute(rel);
    if (outsideCwd && !isArtifactPath(absolute)) {
      logger.debug('captureBaseline: ignoring non-artifact file outside working directory', {
        filePath: absolute,
        workingDirectory: this.workingDirectory,
      });
      return;
    }

    // Only capture once per turn.
    if (this.baselines.has(absolute)) {
      return;
    }

    const content = readFileContent(absolute);
    if (content === undefined) {
      logger.debug('captureBaseline: skipping large file', { filePath: absolute });
      return;
    }

    this.baselines.set(absolute, content);
    logger.debug('captureBaseline: captured baseline', {
      filePath: absolute,
      binary: content === null,
    });
  }

  /**
   * Compute line-level diffs for all captured baselines vs their current
   * on-disk state.  Accumulates results into session stats.
   *
   * After computing, all per-turn baselines are cleared so the next turn
   * starts fresh.
   *
   * Returns the current accumulated `SessionDiffStats`.
   */
  computeDiff(): SessionDiffStats {
    for (const [absolute, baseline] of this.baselines) {
      const relPath = path.relative(this.workingDirectory, absolute);

      // Binary file — count as 1 file changed, 0 line changes.
      if (baseline === null) {
        this.accumulateFileEntry(relPath, {
          path: relPath,
          status: 'modified',
          added: 0,
          deleted: 0,
        });
        continue;
      }

      const current = readFileContent(absolute);

      // File was too large to read now — skip.
      if (current === undefined) {
        continue;
      }

      // Newly-added binary file — treat like binary.
      if (current === null) {
        this.accumulateFileEntry(relPath, {
          path: relPath,
          status: baseline === '' ? 'added' : 'modified',
          added: 0,
          deleted: 0,
        });
        continue;
      }

      // Both baseline and current are text — run diffLines.
      const hunks = diffLines(baseline, current);
      let added = 0;
      let deleted = 0;

      for (const hunk of hunks) {
        const lineCount = hunk.count ?? 0;
        if (hunk.added) {
          added += lineCount;
        } else if (hunk.removed) {
          deleted += lineCount;
        }
      }

      // No changes — nothing to record.
      if (added === 0 && deleted === 0) {
        continue;
      }

      let status: FileDiffEntry['status'];
      if (baseline === '' && current !== '') {
        status = 'added';
      } else if (current === '') {
        status = 'deleted';
      } else {
        status = 'modified';
      }

      this.accumulateFileEntry(relPath, { path: relPath, status, added, deleted });
    }

    // Clear baselines for the next turn.
    this.baselines.clear();

    logger.debug('computeDiff: completed', {
      totalAdded: this.stats.totalAdded,
      totalDeleted: this.stats.totalDeleted,
      fileCount: Object.keys(this.stats.files).length,
    });

    return this.getStats();
  }

  /**
   * Returns the current accumulated stats (a shallow clone — safe to pass over
   * IPC without mutation risk on the `files` record values).
   */
  getStats(): SessionDiffStats {
    return {
      totalAdded: this.stats.totalAdded,
      totalDeleted: this.stats.totalDeleted,
      files: { ...this.stats.files },
    };
  }

  /**
   * Reset all accumulated state.  Call when starting a new session.
   */
  reset(): void {
    this.baselines.clear();
    this.stats = {
      totalAdded: 0,
      totalDeleted: 0,
      files: {},
    };
    logger.debug('SessionDiffTracker: reset');
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Merge a new `FileDiffEntry` into the accumulated session stats.
   * If the file already has an entry (from a previous turn), the line counts
   * are summed and the status is updated to reflect the net change.
   */
  private accumulateFileEntry(relPath: string, entry: FileDiffEntry): void {
    const existing = this.stats.files[relPath];

    if (existing) {
      existing.added += entry.added;
      existing.deleted += entry.deleted;
      // If we had a previous status, let the later one win for 'deleted';
      // otherwise keep the earliest meaningful status (added > modified).
      if (entry.status === 'deleted') {
        existing.status = 'deleted';
      } else if (existing.status === 'added') {
        // File was added earlier in the session — keep 'added'.
      } else {
        existing.status = entry.status;
      }
    } else {
      this.stats.files[relPath] = { ...entry };
    }

    this.stats.totalAdded += entry.added;
    this.stats.totalDeleted += entry.deleted;
  }
}
