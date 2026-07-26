import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { LoopFileChange } from '../../shared/types/loop.types';
import {
  codeIndexDirectoryIgnoreNames,
  codeIndexFileIgnoreNames,
  codeIndexFileIgnoreSuffixes,
} from '../codemem/code-index-ignores';

interface WorkspaceSnapshotEntry {
  contentHash: string;
}

export interface WorkspaceSnapshotOptions {
  maxFiles?: number;
  maxDirectories?: number;
  excludedRelativeDirs?: readonly string[];
}

export type WorkspaceObservationCoverage = 'complete' | 'partial' | 'failed';

export interface WorkspaceSnapshot {
  entries: Map<string, WorkspaceSnapshotEntry>;
  coverage: WorkspaceObservationCoverage;
  reason?: string;
  skippedPathCount: number;
  keys(): IterableIterator<string>;
}

export interface WorkspaceSnapshotDelta {
  changes: LoopFileChange[];
  coverage: WorkspaceObservationCoverage;
  reason?: string;
}
export type WorkspaceGitRunner = (args: string[], cwd: string) => { status: number | null; stdout: string };

const WORKSPACE_SNAPSHOT_MAX_FILES = 5_000;
const WORKSPACE_SNAPSHOT_MAX_DIRECTORIES = 5_000;
const WORKSPACE_SNAPSHOT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const WORKSPACE_SNAPSHOT_IGNORED_DIRS = new Set([
  // Loop runtime state. `.aio-loop-state` holds the loop's own NOTES.md /
  // OUTSTANDING.md / DONE.txt, rewritten EVERY iteration — counting it as a
  // file change manufactures false "progress" and masks a genuine stall.
  ...codeIndexDirectoryIgnoreNames(),
  // Additional platform build directories covered by Loop's existing policy.
  'build-device',
  'build-simulator',
  // JVM build artifacts. Gradle rewrites its cache on every build, so a
  // Java/Kotlin loop that compiles each iteration would otherwise show dozens
  // of churning `.gradle/...` files and never read as "no progress".
  '.kotlin',
  'bin',
]);
const WORKSPACE_SNAPSHOT_IGNORED_FILES = new Set([
  ...codeIndexFileIgnoreNames(),
  '.DS_Store',
]);
const WORKSPACE_SNAPSHOT_IGNORED_FILE_SUFFIXES = codeIndexFileIgnoreSuffixes();
const WORKSPACE_SNAPSHOT_SOURCE_MARKERS = [
  '.git',
  'angular.json',
  'build.gradle',
  'build.gradle.kts',
  'Cargo.toml',
  'composer.json',
  'deno.json',
  'deno.jsonc',
  'Gemfile',
  'go.mod',
  'lerna.json',
  'mix.exs',
  'nx.json',
  'package.json',
  'pnpm-workspace.yaml',
  'pom.xml',
  'pyproject.toml',
  'settings.gradle',
  'settings.gradle.kts',
  'tsconfig.json',
] as const;
const WORKSPACE_SNAPSHOT_SOURCE_MARKER_NAMES = new Set<string>(WORKSPACE_SNAPSHOT_SOURCE_MARKERS);
const WORKSPACE_SNAPSHOT_PREFERRED_DIRS = new Set([
  'app',
  'apps',
  'lib',
  'libs',
  'modules',
  'packages',
  'plugins',
  'projects',
  'src',
]);

/**
 * True when any path segment is an ignored directory (or the file itself is
 * ignored). Used to keep build/loop-state artifacts out of BOTH the filesystem
 * walk and the `git diff` path — the latter would otherwise leak tracked
 * artifacts (e.g. a repo that committed `.gradle/`) into the progress signal.
 */
function isIgnoredWorkspaceRelPath(relPath: string): boolean {
  const segments = relPath.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return false;
  for (let i = 0; i < segments.length - 1; i++) {
    if (WORKSPACE_SNAPSHOT_IGNORED_DIRS.has(segments[i])) return true;
  }
  const leaf = segments[segments.length - 1];
  return WORKSPACE_SNAPSHOT_IGNORED_DIRS.has(leaf)
    || WORKSPACE_SNAPSHOT_IGNORED_FILES.has(leaf)
    || WORKSPACE_SNAPSHOT_IGNORED_FILE_SUFFIXES.some((suffix) => leaf.endsWith(suffix));
}

const defaultWorkspaceGitRunner: WorkspaceGitRunner = (args, cwd) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout ?? '' };
};

/**
 * Best-effort file change detection: shells out to `git diff --numstat HEAD`
 * inside the workspace, then computes a content hash for each file. Returns
 * an empty list if not a git repo.
 */
export function snapshotFileChangesViaGit(
  cwd: string,
  runner: WorkspaceGitRunner = defaultWorkspaceGitRunner,
): LoopFileChange[] {
  try {
    const numstat = runner(['diff', '--numstat', 'HEAD'], cwd);
    if (numstat.status !== 0 || !numstat.stdout) return [];
    const out: LoopFileChange[] = [];
    for (const line of numstat.stdout.trim().split('\n')) {
      if (!line) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const additions = Number.parseInt(parts[0], 10);
      const deletions = Number.parseInt(parts[1], 10);
      const relPath = parts[2];
      // Drop build/loop-state artifacts even when they're git-tracked, so they
      // never feed the loop's progress / work-hash signals.
      if (isIgnoredWorkspaceRelPath(relPath)) continue;
      const abs = path.resolve(cwd, relPath);
      let contentHash = '';
      try {
        if (fs.existsSync(abs)) {
          const stat = fs.statSync(abs);
          if (stat.isFile()) contentHash = hashWorkspaceFile(abs, stat);
        }
      } catch { /* ignore */ }
      out.push({
        path: relPath,
        additions: Number.isFinite(additions) ? additions : 0,
        deletions: Number.isFinite(deletions) ? deletions : 0,
        contentHash,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function normalizeWorkspacePath(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

function hashWorkspaceFile(absPath: string, stat: fs.Stats): string {
  try {
    if (stat.size <= WORKSPACE_SNAPSHOT_MAX_FILE_BYTES) {
      const buf = fs.readFileSync(absPath);
      return createHash('sha256').update(buf).digest('hex').slice(0, 16);
    }
  } catch {
    // Fall through to a metadata hash. This is still useful for detecting
    // progress in non-git workspaces when a file is unreadable or large.
  }

  return createHash('sha256')
    .update(`${stat.size}:${Math.trunc(stat.mtimeMs)}`)
    .digest('hex')
    .slice(0, 16);
}

function hasSourceMarker(dir: string): boolean {
  try {
    return WORKSPACE_SNAPSHOT_SOURCE_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)));
  } catch {
    return false;
  }
}

function isDeprioritizedWorkspaceDir(name: string): boolean {
  return (
    /(?:^|[-_])archives?(?:[-_]|$)/i.test(name) ||
    /(?:^|[-_])backups?(?:[-_]|$)/i.test(name) ||
    /(?:^|[-_])logs?(?:[-_]|$)/i.test(name) ||
    /^deploy-(?:backups?|verification)$/i.test(name) ||
    /^local-servers?$/i.test(name) ||
    /^tmp$/i.test(name)
  );
}

function workspaceSnapshotEntryPriority(parentDir: string, entry: fs.Dirent): number {
  if (entry.isDirectory()) {
    if (isDeprioritizedWorkspaceDir(entry.name)) return 9;
    if (hasSourceMarker(path.join(parentDir, entry.name))) return 0;
    if (WORKSPACE_SNAPSHOT_PREFERRED_DIRS.has(entry.name)) return 1;
    return 4;
  }
  if (entry.isFile() && WORKSPACE_SNAPSHOT_SOURCE_MARKER_NAMES.has(entry.name)) return 2;
  return 5;
}

export function snapshotWorkspaceFiles(cwd: string, options: WorkspaceSnapshotOptions = {}): WorkspaceSnapshot {
  const root = path.resolve(cwd);
  const snapshotEntries = new Map<string, WorkspaceSnapshotEntry>();
  const maxFiles = options.maxFiles ?? WORKSPACE_SNAPSHOT_MAX_FILES;
  const maxDirectories = options.maxDirectories ?? WORKSPACE_SNAPSHOT_MAX_DIRECTORIES;
  const excluded = new Set(
    (options.excludedRelativeDirs ?? []).map((value) => normalizeWorkspacePath(value).replace(/\/+$/, '')),
  );
  let limitReached = false;
  let directoryLimitReached = false;
  let traversedDirectories = 0;
  let skippedPathCount = 0;
  const queue: Array<{ dir: string; relDir: string }> = [{ dir: root, relDir: '' }];
  const deferredDirectories: Array<{ dir: string; relDir: string }> = [];
  let rootReadable = false;

  while ((queue.length > 0 || deferredDirectories.length > 0) && !limitReached) {
    if (traversedDirectories >= maxDirectories) {
      directoryLimitReached = true;
      break;
    }
    const current = queue.shift() ?? deferredDirectories.shift()!;
    traversedDirectories += 1;
    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(current.dir, { withFileTypes: true });
      if (current.relDir === '') rootReadable = true;
    } catch {
      skippedPathCount += 1;
      continue;
    }

    dirEntries.sort((a, b) => {
      const priorityDelta =
        workspaceSnapshotEntryPriority(current.dir, a) - workspaceSnapshotEntryPriority(current.dir, b);
      return priorityDelta || a.name.localeCompare(b.name);
    });
    for (const entry of dirEntries) {
      if (limitReached) break;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && WORKSPACE_SNAPSHOT_IGNORED_DIRS.has(entry.name)) continue;
      if (
        entry.isFile()
        && (
          WORKSPACE_SNAPSHOT_IGNORED_FILES.has(entry.name)
          || WORKSPACE_SNAPSHOT_IGNORED_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))
        )
      ) continue;

      const relPath = current.relDir ? path.join(current.relDir, entry.name) : entry.name;
      const normalizedRelPath = normalizeWorkspacePath(relPath);
      const absPath = path.join(root, relPath);

      if (entry.isDirectory()) {
        if (!excluded.has(normalizedRelPath)) {
          const target = { dir: absPath, relDir: relPath };
          if (isDeprioritizedWorkspaceDir(entry.name)) {
            deferredDirectories.push(target);
          } else {
            queue.push(target);
          }
        }
        continue;
      }

      if (!entry.isFile()) continue;
      if (snapshotEntries.size >= maxFiles) {
        limitReached = true;
        break;
      }

      try {
        const stat = fs.statSync(absPath);
        if (!stat.isFile()) continue;
        snapshotEntries.set(normalizedRelPath, {
          contentHash: hashWorkspaceFile(absPath, stat),
        });
      } catch {
        skippedPathCount += 1;
      }
    }
  }
  const coverage: WorkspaceObservationCoverage = !rootReadable
    ? 'failed'
    : limitReached || directoryLimitReached || skippedPathCount > 0
      ? 'partial'
      : 'complete';
  const reasons = [
    limitReached ? `filesystem snapshot file limit reached (${maxFiles})` : '',
    directoryLimitReached
      ? `filesystem snapshot directory limit reached (${maxDirectories})`
      : '',
    skippedPathCount > 0 ? `${skippedPathCount} eligible path(s) unreadable` : '',
    !rootReadable ? 'workspace root could not be read' : '',
  ].filter(Boolean);
  return {
    entries: snapshotEntries,
    coverage,
    ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
    skippedPathCount,
    keys: () => snapshotEntries.keys(),
  };
}

export function snapshotFileChangesViaWorkspace(
  before: WorkspaceSnapshot,
  cwd: string,
  options: WorkspaceSnapshotOptions = {},
): LoopFileChange[] {
  return snapshotWorkspaceDelta(before, cwd, options).changes;
}

export function snapshotWorkspaceDelta(
  before: WorkspaceSnapshot,
  cwd: string,
  options: WorkspaceSnapshotOptions = {},
): WorkspaceSnapshotDelta {
  const after = snapshotWorkspaceFiles(cwd, options);
  const paths = new Set<string>([...before.entries.keys(), ...after.entries.keys()]);
  const changes: LoopFileChange[] = [];

  for (const relPath of [...paths].sort()) {
    const prev = before.entries.get(relPath);
    const next = after.entries.get(relPath);
    if (prev?.contentHash === next?.contentHash) continue;

    changes.push({
      path: relPath,
      additions: prev ? 0 : 1,
      deletions: next ? 0 : 1,
      contentHash: next?.contentHash ?? '',
    });
  }

  const coverage: WorkspaceObservationCoverage =
    before.coverage === 'failed' || after.coverage === 'failed'
      ? 'failed'
      : before.coverage === 'partial' || after.coverage === 'partial'
        ? 'partial'
        : 'complete';
  const reason = [before.reason, after.reason].filter(Boolean).join('; ');
  return { changes, coverage, ...(reason ? { reason } : {}) };
}

export function mergeFileChanges(...groups: LoopFileChange[][]): LoopFileChange[] {
  const byPath = new Map<string, LoopFileChange>();
  for (const group of groups) {
    for (const change of group) {
      byPath.set(change.path, change);
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Compare two `git diff HEAD` snapshots and return only paths whose dirty
 * state changed during the iteration. This lets Git recover tracked edits
 * that a bounded filesystem walk missed without re-reporting dirt that was
 * already present before the iteration started.
 */
export function diffFileChangeSnapshots(
  before: readonly LoopFileChange[],
  after: readonly LoopFileChange[],
): LoopFileChange[] {
  const beforeByPath = new Map(before.map((change) => [change.path, change]));
  const afterByPath = new Map(after.map((change) => [change.path, change]));
  const paths = new Set([...beforeByPath.keys(), ...afterByPath.keys()]);
  const changes: LoopFileChange[] = [];

  for (const filePath of [...paths].sort()) {
    const previous = beforeByPath.get(filePath);
    const current = afterByPath.get(filePath);
    if (sameFileChange(previous, current)) continue;
    changes.push(current ?? {
      path: filePath,
      additions: 0,
      deletions: 0,
      contentHash: '',
    });
  }

  return changes;
}

function sameFileChange(
  left: LoopFileChange | undefined,
  right: LoopFileChange | undefined,
): boolean {
  return left?.path === right?.path
    && left?.additions === right?.additions
    && left?.deletions === right?.deletions
    && left?.contentHash === right?.contentHash;
}
