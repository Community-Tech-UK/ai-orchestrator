/**
 * SessionDiffTracker — captures file snapshots and computes line-level diffs
 * to report the session-wide NET change (added/deleted line counts) for each
 * file the agent touches.
 *
 * One tracker is created per active instance. The lifecycle is:
 *   1. Agent tool calls trigger captureBaseline() for each file they read/write.
 *      The FIRST snapshot seen for a file becomes its session baseline and is
 *      retained for the whole session (later captures of the same file are
 *      ignored).
 *   2. At the end of a turn computeDiff() is called — it re-snapshots every
 *      baseline file's current state and diffs it against that file's session
 *      baseline. Stats are recomputed from scratch (net current-vs-baseline),
 *      so the numbers reflect the net surviving change rather than cumulative
 *      per-turn churn. Baselines are NOT cleared — they persist for the session.
 *   3. reset() zeroes all accumulated stats and drops baselines (used when
 *      starting a fresh session).
 *
 * Because each computeDiff() re-diffs against the original session baseline:
 *   - Re-editing the same file across many turns is not double-counted.
 *   - Changes that are later reverted net back to zero and drop out entirely.
 *   - The total converges to what `git diff --numstat` reports against the
 *     state each file had when the session first touched it.
 *
 * Baselines are stored as a discriminated union of `text` (full content for
 * line-level diff), `binary` (size + mtimeMs for change-detection without
 * holding the full content in memory), or `absent` (file did not exist).
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
 * A snapshot of a file at a point in time.
 *
 * - `text`   — text file with its full UTF-8 contents, used for line-level diff.
 * - `binary` — binary file: only size + mtimeMs are recorded so unchanged
 *              binaries can be detected cheaply without holding the full file
 *              in memory.
 * - `absent` — file did not exist at snapshot time.
 */
type FileSnapshot =
  | { kind: 'text'; content: string }
  | { kind: 'binary'; size: number; mtimeMs: number }
  | { kind: 'absent' };

/**
 * Snapshot `filePath`. Returns:
 *   - `{ kind: 'absent' }`  — file does not exist.
 *   - `{ kind: 'binary', size, mtimeMs }` — file is binary (null byte found in
 *     the first BINARY_DETECT_BYTES). Content is intentionally NOT read.
 *   - `{ kind: 'text', content }` — file is text; full UTF-8 content captured.
 *   - `undefined` — file is larger than MAX_FILE_SIZE_BYTES (caller skips).
 */
function snapshotFile(filePath: string): FileSnapshot | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    // File does not exist — treat as absent baseline.
    return { kind: 'absent' };
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
        return { kind: 'binary', size: stat.size, mtimeMs: stat.mtimeMs };
      }
    }

    // Read full content as text.
    const buf = Buffer.alloc(stat.size);
    fs.readSync(fd, buf, 0, stat.size, 0);
    return { kind: 'text', content: buf.toString('utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Run a line-level diff and return added / deleted line counts.
 */
function lineDiffCounts(before: string, after: string): { added: number; deleted: number } {
  const hunks = diffLines(before, after);
  let added = 0;
  let deleted = 0;
  for (const hunk of hunks) {
    const lineCount = hunk.count ?? 0;
    if (hunk.added) added += lineCount;
    else if (hunk.removed) deleted += lineCount;
  }
  return { added, deleted };
}

/**
 * Compute the net change between a file's session baseline and its current
 * snapshot. Returns `null` when there is no meaningful change (unchanged file,
 * a file that never appeared, or a net-zero edit), so callers can drop the
 * entry entirely.
 */
function diffSnapshot(
  relPath: string,
  baseline: FileSnapshot,
  current: FileSnapshot
): FileDiffEntry | null {
  // baseline absent → either nothing happened (both absent) or the file was
  // created during the session (ADDED). Handled first so the rest can assume
  // baseline is text|binary.
  if (baseline.kind === 'absent') {
    if (current.kind === 'absent') {
      return null; // file never appeared
    }
    if (current.kind === 'binary') {
      return { path: relPath, status: 'added', added: 0, deleted: 0 };
    }
    // text — count its lines as added
    const { added, deleted } = lineDiffCounts('', current.content);
    if (added === 0 && deleted === 0) return null; // file created empty
    return { path: relPath, status: 'added', added, deleted };
  }

  // baseline is text|binary from here on.
  // current absent → DELETED.
  if (current.kind === 'absent') {
    if (baseline.kind === 'binary') {
      return { path: relPath, status: 'deleted', added: 0, deleted: 0 };
    }
    // text — count its baseline lines as deleted
    const { added, deleted } = lineDiffCounts(baseline.content, '');
    return { path: relPath, status: 'deleted', added, deleted };
  }

  // Both present — handle binary / text combinations.
  if (baseline.kind === 'binary' || current.kind === 'binary') {
    // Both binary: skip when size + mtimeMs are unchanged. This prevents the
    // long-standing false positive where a binary file the agent merely
    // referenced (e.g. `cat foo.docx | head`) was always surfaced as
    // "Updated" even though nothing was written.
    if (
      baseline.kind === 'binary' &&
      current.kind === 'binary' &&
      baseline.size === current.size &&
      baseline.mtimeMs === current.mtimeMs
    ) {
      return null;
    }
    // Mixed kind or changed binary → modified with 0/0 lines.
    return { path: relPath, status: 'modified', added: 0, deleted: 0 };
  }

  // Both text — line-level diff.
  const { added, deleted } = lineDiffCounts(baseline.content, current.content);
  if (added === 0 && deleted === 0) return null;

  // Treat empty-text → non-empty-text as "added" so newly populated files show
  // the right status; non-empty → empty as "deleted".
  let status: FileDiffEntry['status'];
  if (baseline.content === '' && current.content !== '') {
    status = 'added';
  } else if (current.content === '') {
    status = 'deleted';
  } else {
    status = 'modified';
  }

  return { path: relPath, status, added, deleted };
}

// ============================================================================
// SessionDiffTracker
// ============================================================================

/**
 * Tracks per-file session baselines and reports the net line-level diff between
 * each file's first-seen state and its current state.
 */
export class SessionDiffTracker {
  /**
   * Session baseline snapshot captured the FIRST time each file was touched.
   * Retained for the whole session so every computeDiff() re-diffs against the
   * original state (net change), not the previous turn (cumulative churn).
   * Key: absolute file path.
   */
  private sessionBaselines = new Map<string, FileSnapshot>();

  /**
   * Net diff stats for the entire session. Recomputed from scratch on every
   * computeDiff() call as the sum of each file's net current-vs-baseline diff.
   */
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
   * Capture the session baseline state of `filePath`.
   *
   * Rules:
   * - A file's baseline is captured ONCE per session — the first snapshot wins
   *   and is retained for the whole session (subsequent calls for the same path
   *   are ignored, so re-editing a file across turns is diffed against its
   *   original state, not the previous turn).
   * - Paths outside `workingDirectory` are only tracked if they are
   *   user-facing artifacts (md, pdf, png, docx, etc.). Code files outside
   *   cwd stay ignored.
   * - Non-existent files get an `absent` baseline.
   * - Binary files get a `binary` baseline (size + mtimeMs only — no content).
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

    // Only capture once per session — the first snapshot is the baseline.
    if (this.sessionBaselines.has(absolute)) {
      return;
    }

    const snapshot = snapshotFile(absolute);
    if (snapshot === undefined) {
      logger.debug('captureBaseline: skipping large file', { filePath: absolute });
      return;
    }

    this.sessionBaselines.set(absolute, snapshot);
    logger.debug('captureBaseline: captured baseline', {
      filePath: absolute,
      kind: snapshot.kind,
    });
  }

  /**
   * Re-snapshot the current state of every session baseline file, diff it
   * against that file's baseline, and rebuild the session stats from scratch.
   *
   * Stats reflect the NET change (current vs the file's first-seen baseline),
   * so a file edited across many turns is counted once and reverted edits drop
   * out. Baselines are retained for the rest of the session.
   *
   * Returns the current `SessionDiffStats`.
   */
  computeDiff(): SessionDiffStats {
    const files: Record<string, FileDiffEntry> = {};
    let totalAdded = 0;
    let totalDeleted = 0;

    for (const [absolute, baseline] of this.sessionBaselines) {
      const current = snapshotFile(absolute);

      // File became too large to re-read — leave its prior entry out; we can't
      // reliably measure it this turn.
      if (current === undefined) {
        continue;
      }

      const relPath = path.relative(this.workingDirectory, absolute);
      const entry = diffSnapshot(relPath, baseline, current);
      if (!entry) {
        continue; // unchanged or net-zero → omit
      }

      files[relPath] = entry;
      totalAdded += entry.added;
      totalDeleted += entry.deleted;
    }

    this.stats = { totalAdded, totalDeleted, files };

    logger.debug('computeDiff: completed', {
      totalAdded,
      totalDeleted,
      fileCount: Object.keys(files).length,
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
   * Reset all state, including session baselines. Call when starting a new
   * session.
   */
  reset(): void {
    this.sessionBaselines.clear();
    this.stats = {
      totalAdded: 0,
      totalDeleted: 0,
      files: {},
    };
    logger.debug('SessionDiffTracker: reset');
  }
}
