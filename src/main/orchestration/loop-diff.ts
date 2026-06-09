/**
 * Workspace diff collection for fresh-eyes review.
 *
 * The fresh-eyes reviewer must judge the *actual change* the loop produced —
 * the git diff — not the agent's self-narrated summary of what it did. Feeding
 * the diff (a) gives the reviewer ground truth instead of an optimistic
 * transcript, and (b) is far smaller than a full conversation transcript, so
 * it sidesteps the review-payload truncation that previously starved reviewers
 * of context.
 *
 * We compare against `HEAD` (cumulative uncommitted change) because loop
 * iterations edit the working tree without committing. Untracked files are
 * included verbatim (bounded) — new files are exactly what a reviewer should
 * scrutinise. When the workspace is not a git repository, the collector
 * degrades to an empty diff with `source: 'none'`; the reviewer then falls
 * back to the goal + changed-file list, which the caller still supplies.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { LOOP_TEXT_FILE_MAX_BYTES, readUtf8FileHeadSync } from './bounded-file-read';

export type WorkspaceDiffSource = 'git' | 'none';

export interface WorkspaceDiff {
  /** Combined stat header + tracked diff + untracked-file blocks. */
  diff: string;
  source: WorkspaceDiffSource;
  truncated: boolean;
  /** Files referenced in the diff (relative paths), best-effort. */
  changedFiles: string[];
}

export interface CollectWorkspaceDiffOptions {
  /** Hard cap on the returned diff text. Default 64 KB. */
  maxChars?: number;
  /** Per-untracked-file content cap. Default 16 KB. */
  maxUntrackedFileChars?: number;
}

/**
 * Injectable git runner so the formatting/bounding logic is unit-testable
 * without a real repository. Returns `null` status on spawn failure.
 */
export type GitRunner = (args: string[], cwd: string) => { status: number | null; stdout: string };

const DEFAULT_MAX_CHARS = 64_000;
const DEFAULT_MAX_UNTRACKED_FILE_CHARS = 16_000;

/**
 * Untracked paths never forwarded to reviewers. `.aio-loop-control` notably
 * holds the loop-control secret token — including it in a diff shipped to an
 * external reviewer CLI would leak it. The rest are pure noise.
 */
const IGNORED_UNTRACKED_PREFIXES = [
  '.aio-loop-control/',
  '.aio-loop-attachments/',
  '.git/',
  'node_modules/',
];

function isIgnoredUntracked(relPath: string): boolean {
  const normalized = relPath.split('\\').join('/');
  return IGNORED_UNTRACKED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

const defaultGitRunner: GitRunner = (args, cwd) => {
  try {
    const res = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: res.status, stdout: res.stdout ?? '' };
  } catch {
    return { status: null, stdout: '' };
  }
};

/** Read an untracked file's leading bytes for inclusion as a "new file" block. */
function readUntrackedHead(absPath: string, maxChars: number): { text: string; truncated: boolean } | null {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return null;
    const readLimit = Math.min(Math.max(maxChars, 8_000), LOOP_TEXT_FILE_MAX_BYTES);
    const read = readUtf8FileHeadSync(absPath, readLimit);
    // Skip obvious binaries: a NUL byte in the leading window is a strong hint.
    if (read.text.includes('\0')) return { text: '(binary file omitted)', truncated: false };
    if (!read.truncated && read.text.length <= maxChars) return { text: read.text, truncated: false };
    return { text: read.text.slice(0, maxChars), truncated: true };
  } catch {
    return null;
  }
}

export function collectWorkspaceDiff(
  workspaceCwd: string,
  options: CollectWorkspaceDiffOptions = {},
  runner: GitRunner = defaultGitRunner,
): WorkspaceDiff {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxUntrackedFileChars = options.maxUntrackedFileChars ?? DEFAULT_MAX_UNTRACKED_FILE_CHARS;

  const insideRepo = runner(['rev-parse', '--is-inside-work-tree'], workspaceCwd);
  if (insideRepo.status !== 0 || !/true/i.test(insideRepo.stdout)) {
    return { diff: '', source: 'none', truncated: false, changedFiles: [] };
  }

  const sections: string[] = [];
  const changedFiles = new Set<string>();

  // Stat header — a compact overview the reviewer can scan first.
  const stat = runner(['-c', 'core.pager=cat', 'diff', '--stat', 'HEAD'], workspaceCwd);
  if (stat.status === 0 && stat.stdout.trim()) {
    sections.push(`## Change summary (git diff --stat HEAD)\n${stat.stdout.trim()}`);
  }

  // Tracked changes vs HEAD (staged + unstaged).
  const tracked = runner(['-c', 'core.pager=cat', 'diff', 'HEAD'], workspaceCwd);
  if (tracked.status === 0 && tracked.stdout.trim()) {
    sections.push(`## Tracked changes (git diff HEAD)\n${tracked.stdout.trimEnd()}`);
    for (const m of tracked.stdout.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
      if (m[1] && m[1] !== '/dev/null') changedFiles.add(m[1]);
    }
  }

  // Untracked files (new files) — included verbatim, bounded.
  const untracked = runner(['ls-files', '--others', '--exclude-standard'], workspaceCwd);
  if (untracked.status === 0 && untracked.stdout.trim()) {
    const blocks: string[] = [];
    for (const rel of untracked.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (isIgnoredUntracked(rel)) continue;
      const head = readUntrackedHead(path.join(workspaceCwd, rel), maxUntrackedFileChars);
      if (!head) continue;
      changedFiles.add(rel);
      const suffix = head.truncated ? '\n… (untracked file truncated)' : '';
      blocks.push(`+++ new file: ${rel}\n${head.text}${suffix}`);
    }
    if (blocks.length > 0) {
      sections.push(`## New (untracked) files\n${blocks.join('\n\n')}`);
    }
  }

  let diff = sections.join('\n\n');
  let truncated = false;
  if (diff.length > maxChars) {
    diff = diff.slice(0, maxChars) + '\n… (diff truncated for review)';
    truncated = true;
  }

  return {
    diff,
    source: 'git',
    truncated,
    changedFiles: [...changedFiles].sort(),
  };
}
