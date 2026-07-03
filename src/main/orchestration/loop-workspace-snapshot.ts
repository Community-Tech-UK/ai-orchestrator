import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { LoopFileChange } from '../../shared/types/loop.types';

interface WorkspaceSnapshotEntry {
  contentHash: string;
}

interface WorkspaceSnapshotOptions {
  maxFiles?: number;
}

export type WorkspaceSnapshot = Map<string, WorkspaceSnapshotEntry>;
export type WorkspaceGitRunner = (args: string[], cwd: string) => { status: number | null; stdout: string };

const WORKSPACE_SNAPSHOT_MAX_FILES = 5_000;
const WORKSPACE_SNAPSHOT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const WORKSPACE_SNAPSHOT_IGNORED_DIRS = new Set([
  // Loop runtime state. `.aio-loop-state` holds the loop's own NOTES.md /
  // OUTSTANDING.md / DONE.txt, rewritten EVERY iteration — counting it as a
  // file change manufactures false "progress" and masks a genuine stall.
  '.aio-loop-attachments',
  '.aio-loop-control',
  '.aio-loop-state',
  // JS/TS build + tool caches.
  '.angular',
  '.cache',
  '.git',
  '.next',
  '.nuxt',
  '.turbo',
  '.vite',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  // JVM build artifacts. Gradle rewrites its cache on every build, so a
  // Java/Kotlin loop that compiles each iteration would otherwise show dozens
  // of churning `.gradle/...` files and never read as "no progress".
  '.gradle',
  '.kotlin',
  'bin',
  'target',
]);
const WORKSPACE_SNAPSHOT_IGNORED_FILES = new Set(['.DS_Store']);
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
  return WORKSPACE_SNAPSHOT_IGNORED_DIRS.has(leaf) || WORKSPACE_SNAPSHOT_IGNORED_FILES.has(leaf);
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
  const snapshot: WorkspaceSnapshot = new Map();
  const maxFiles = options.maxFiles ?? WORKSPACE_SNAPSHOT_MAX_FILES;
  let limitReached = false;

  const visit = (dir: string, relDir: string): void => {
    if (limitReached) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => {
      const priorityDelta =
        workspaceSnapshotEntryPriority(dir, a) - workspaceSnapshotEntryPriority(dir, b);
      return priorityDelta || a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (limitReached) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && WORKSPACE_SNAPSHOT_IGNORED_DIRS.has(entry.name)) continue;
      if (entry.isFile() && WORKSPACE_SNAPSHOT_IGNORED_FILES.has(entry.name)) continue;

      const relPath = relDir ? path.join(relDir, entry.name) : entry.name;
      const absPath = path.join(root, relPath);

      if (entry.isDirectory()) {
        visit(absPath, relPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (snapshot.size >= maxFiles) {
        limitReached = true;
        return;
      }

      try {
        const stat = fs.statSync(absPath);
        if (!stat.isFile()) continue;
        snapshot.set(normalizeWorkspacePath(relPath), {
          contentHash: hashWorkspaceFile(absPath, stat),
        });
      } catch {
        // Best effort only.
      }
    }
  };

  visit(root, '');
  return snapshot;
}

export function snapshotFileChangesViaWorkspace(
  before: WorkspaceSnapshot,
  cwd: string,
  options: WorkspaceSnapshotOptions = {},
): LoopFileChange[] {
  const after = snapshotWorkspaceFiles(cwd, options);
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  const changes: LoopFileChange[] = [];

  for (const relPath of [...paths].sort()) {
    const prev = before.get(relPath);
    const next = after.get(relPath);
    if (prev?.contentHash === next?.contentHash) continue;

    changes.push({
      path: relPath,
      additions: prev ? 0 : 1,
      deletions: next ? 0 : 1,
      contentHash: next?.contentHash ?? '',
    });
  }

  return changes;
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
