/**
 * L2 — skip an identical-tree verify re-run and replay the recorded result.
 *
 * `lastVerifiedWorkHash` / `isVerifyEvidenceStale` invalidate a PASS after
 * edits, but nothing stops the loop re-running a multi-minute verify against a
 * tree it has already graded. A child that declares completion twice without
 * touching a file pays the same red suite twice and learns nothing new.
 *
 * Deliberate limits, each one load-bearing:
 *
 * - **Only reds replay.** A green is what unlocks completion; replaying one
 *   would be self-grading from a cache. A red never grants completion, so
 *   replaying it can only save money.
 * - **Only `failureKind: 'command'` replays.** `infra` / `timeout` /
 *   `environment` failures can heal without a tree change (deps provisioned, a
 *   flaky spawn, a freed port). Replaying those would wedge the loop on a
 *   condition that no longer exists — the T37 empty-worktree class of bug.
 * - **Fail open.** An uncomputable tree hash, a non-git workspace, or a stale
 *   entry means "run it", never "assume the old answer".
 * - **Command and cwd are part of the key.** A changed verify command or a
 *   different execution cwd is a different question.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LOOP_TEXT_FILE_MAX_BYTES } from './bounded-file-read';
import { defaultGitRunner, isDiffCapableWorkspace, type GitRunner } from './loop-diff';

/** Beyond this age a recorded red is re-run rather than replayed. */
export const VERIFY_REPLAY_MAX_AGE_MS = 30 * 60 * 1000;
/** Loop runs kept in the cache before the oldest is evicted. */
const MAX_TRACKED_LOOPS = 20;
/** Entries kept per loop run before the oldest is evicted. */
const MAX_ENTRIES_PER_LOOP = 8;

export interface VerifyReplayKey {
  kind: 'verify' | 'quick-verify';
  command: string;
  cwd: string;
  treeHash: string;
}

export interface VerifyReplayRecord {
  treeHash: string;
  command: string;
  exitCode: number | null;
  output: string;
  durationMs: number;
  failureKind: 'command';
  recordedAt: number;
}

function keyOf(key: VerifyReplayKey): string {
  return [key.kind, key.command, key.cwd, key.treeHash].join('\u0000');
}

/**
 * Hash of the SOURCE state a verify command runs against: the commit it sits
 * on, the full tracked diff, the content of every untracked file, and the
 * newest mtime under the build-output directory. Returns `null` (fail open)
 * when git cannot answer.
 *
 * **This is not everything a verify could observe, and it must not claim to
 * be.** `git ls-files --others --exclude-standard` deliberately excludes
 * IGNORED files, so caches, `.env` files and other gitignored inputs are
 * invisible here. Build output is folded in explicitly because it is the
 * common case (a rebuild between two identical-source claims), but the residual
 * risk is real and is what {@link VERIFY_REPLAY_MAX_AGE_MS} bounds: at worst a
 * red is replayed for half an hour after an ignored input changed.
 *
 * This deliberately does NOT reuse `collectWorkspaceDiff`: that output is
 * truncated at `MAX_REVIEW_DIFF_CHARS`, so two genuinely different trees could
 * hash the same past the cap and a replayed red would outlive the change that
 * fixed it.
 */
export function computeVerifyTreeHash(
  cwd: string,
  runner: GitRunner = defaultGitRunner,
  readFile: (absPath: string) => Buffer = (p) => fs.readFileSync(p),
): string | null {
  if (!isDiffCapableWorkspace(cwd, runner)) return null;

  const head = runner(['rev-parse', 'HEAD'], cwd);
  const tracked = runner(['-c', 'core.pager=cat', 'diff', 'HEAD'], cwd);
  const untracked = runner(['ls-files', '--others', '--exclude-standard'], cwd);
  // A HEAD-less repository (no commits yet) still diffs as "everything
  // untracked", so only the two listing commands are required.
  if (tracked.status !== 0 || untracked.status !== 0) return null;

  const hash = createHash('sha256');
  hash.update('head\u0000');
  hash.update(head.status === 0 ? head.stdout.trim() : '(no-head)');
  hash.update('\u0000tracked\u0000');
  hash.update(tracked.stdout);

  // Build output is gitignored, so nothing above sees a rebuild. Folding in a
  // recursive fingerprint closes the "same sources, freshly rebuilt" case that
  // would otherwise replay a stale red.
  const buildFingerprint = buildOutputFingerprint(cwd);
  // A build tree too large to fingerprint completely means we cannot tell a
  // rebuild from a no-op, so replay must not be offered at all.
  if (buildFingerprint === null) return null;
  hash.update('\u0000build\u0000');
  hash.update(buildFingerprint);

  const untrackedPaths = untracked.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  for (const rel of untrackedPaths) {
    hash.update('\u0000untracked\u0000');
    hash.update(rel);
    try {
      const abs = path.join(cwd, rel);
      const stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
      hash.update(`\u0000size:${stat.size}\u0000`);
      // Large files contribute size only. A verify-relevant source file is
      // never megabytes, and reading build artefacts on every claim would cost
      // more than the verify run we are trying to skip.
      if (stat.size <= LOOP_TEXT_FILE_MAX_BYTES) hash.update(readFile(abs));
    } catch {
      // An unreadable path is indistinguishable from a changed one — fail open
      // rather than pretend the tree is the same.
      return null;
    }
  }
  return hash.digest('hex');
}

/**
 * Bounded, in-process store of replayable verify reds, keyed by loop run.
 * Nothing here is durable: a restarted app re-runs verify, which is the safe
 * direction.
 */
export class LoopVerifyReplayCache {
  private readonly byLoop = new Map<string, Map<string, VerifyReplayRecord>>();

  lookup(loopRunId: string, key: VerifyReplayKey, now = Date.now()): VerifyReplayRecord | null {
    const entries = this.byLoop.get(loopRunId);
    if (!entries) return null;
    const record = entries.get(keyOf(key));
    if (!record) return null;
    if (now - record.recordedAt > VERIFY_REPLAY_MAX_AGE_MS) {
      entries.delete(keyOf(key));
      return null;
    }
    return record;
  }

  record(loopRunId: string, key: VerifyReplayKey, record: VerifyReplayRecord): void {
    let entries = this.byLoop.get(loopRunId);
    if (!entries) {
      entries = new Map<string, VerifyReplayRecord>();
      this.byLoop.set(loopRunId, entries);
      while (this.byLoop.size > MAX_TRACKED_LOOPS) {
        const oldest = this.byLoop.keys().next();
        if (oldest.done) break;
        this.byLoop.delete(oldest.value);
      }
    }
    entries.set(keyOf(key), record);
    while (entries.size > MAX_ENTRIES_PER_LOOP) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  clear(loopRunId?: string): void {
    if (loopRunId === undefined) this.byLoop.clear();
    else this.byLoop.delete(loopRunId);
  }
}

/** Prefix added to a replayed red so the child never mistakes it for a new run. */
export function renderReplayNotice(record: VerifyReplayRecord, now = Date.now()): string {
  const ageSeconds = Math.max(0, Math.round((now - record.recordedAt) / 1000));
  return `[loop] Verify was NOT re-run: the working tree is byte-identical to the tree that failed `
    + `\`${record.command}\` ${ageSeconds}s ago (exit ${record.exitCode ?? 'null'}). `
    + `Change something and declare completion again to force a fresh run.\n`;
}

/** Conventional build-output directories, mirroring `loop-artifact-freshness`. */
const BUILD_OUTPUT_DIRS = ['dist', 'build', 'out', 'lib'] as const;
/**
 * Ceiling on the build-output walk. Generous on purpose: exceeding it disables
 * replay rather than truncating, so it only needs to catch pathological trees.
 */
export const MAX_BUILD_OUTPUT_ENTRIES = 60_000;

/**
 * A fingerprint of the build output: the newest mtime found under it and how
 * many files were seen. `null` means "could not be established" and disables
 * replay for this attempt.
 *
 * **Complete, or nothing.** Three earlier versions were wrong here and all
 * three failed the same way — a confident answer from a partial view:
 *
 *  1. A one-level scan read `dist/` and its immediate children only. This
 *     repo's output is `dist/main/**` and `dist/renderer/browser/**`, and
 *     recompiling a file in place moves neither directory's own mtime, so a
 *     real rebuild was invisible.
 *  2. A recursive scan capped at 4,000 entries exhausted its budget inside
 *     `dist/main` — this repo's `dist/` holds ~25,000 files — so
 *     `dist/renderer` and even `dist/main/orchestration` were NEVER VISITED.
 *  3. An unreadable subdirectory was swallowed and treated as empty, so a
 *     permission error, a container mount, or an `rm -rf dist && tsc` race
 *     produced a stable hash that was blind to everything under it.
 *
 * Hence the rule, applied uniformly: ANY input we cannot read — an overflowing
 * tree, an unreadable directory, an unreadable file — returns `null`. The cost
 * of failing open is one real verify run; the cost of a blind fingerprint is a
 * silently wedged loop. A missing build directory is not a failure: there is
 * simply nothing to fingerprint.
 *
 * Symlinks fail open. A `Dirent` for a symlink reports `isDirectory() === false`
 * AND `isFile() === false` whatever it points at, so an earlier version fell
 * through both branches and skipped the entry in silence — not counted, not
 * stat'd, not flagged. That is case 3 again in a quieter costume, so a symlink
 * anywhere under the build output now disables replay rather than being ignored.
 * No build config here symlinks into `dist/` today, so this costs nothing; if
 * one ever does, the loop runs a real verify instead of trusting a partial view.
 */
export function buildOutputFingerprint(
  cwd: string,
  maxEntries: number = MAX_BUILD_OUTPUT_ENTRIES,
): string | null {
  let newest = 0;
  let seen = 0;
  let established = true;

  const walk = (dir: string): void => {
    if (!established) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Cannot see inside — an entire subtree is unaccounted for.
      established = false;
      return;
    }
    for (const entry of entries) {
      if (!established) return;
      if (seen >= maxEntries) {
        established = false;
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // Neither a file nor a directory to `Dirent`; resolving it invites
        // cycles, and ignoring it hides whatever it points at.
        established = false;
        return;
      }
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      seen += 1;
      try {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      } catch {
        established = false;
        return;
      }
    }
  };

  for (const dir of BUILD_OUTPUT_DIRS) {
    const root = path.join(cwd, dir);
    let isDir = false;
    try {
      isDir = fs.statSync(root).isDirectory();
    } catch (err) {
      // A missing directory is legitimately "no build output here". Anything
      // else (EACCES, EIO) means we cannot tell, so we must not guess.
      if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue;
      return null;
    }
    if (!isDir) continue;
    walk(root);
    if (!established) return null;
  }
  return `${newest}:${seen}`;
}

