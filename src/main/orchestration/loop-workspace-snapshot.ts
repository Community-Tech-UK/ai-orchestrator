import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { LoopFileChange } from '../../shared/types/loop.types';

interface WorkspaceSnapshotEntry {
  contentHash: string;
}

export type WorkspaceSnapshot = Map<string, WorkspaceSnapshotEntry>;

const WORKSPACE_SNAPSHOT_MAX_FILES = 5_000;
const WORKSPACE_SNAPSHOT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const WORKSPACE_SNAPSHOT_IGNORED_DIRS = new Set([
  '.aio-loop-attachments',
  '.aio-loop-control',
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
]);
const WORKSPACE_SNAPSHOT_IGNORED_FILES = new Set(['.DS_Store']);

/**
 * Best-effort file change detection: shells out to `git diff --numstat HEAD`
 * inside the workspace, then computes a content hash for each file. Returns
 * an empty list if not a git repo.
 */
export function snapshotFileChangesViaGit(cwd: string): LoopFileChange[] {
  try {
    const numstat = spawnSync('git', ['diff', '--numstat', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (numstat.status !== 0 || !numstat.stdout) return [];
    const out: LoopFileChange[] = [];
    for (const line of numstat.stdout.trim().split('\n')) {
      if (!line) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const additions = Number.parseInt(parts[0], 10);
      const deletions = Number.parseInt(parts[1], 10);
      const relPath = parts[2];
      const abs = path.resolve(cwd, relPath);
      let contentHash = '';
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          const buf = fs.readFileSync(abs);
          contentHash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
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

export function snapshotWorkspaceFiles(cwd: string): WorkspaceSnapshot {
  const root = path.resolve(cwd);
  const snapshot: WorkspaceSnapshot = new Map();
  let limitReached = false;

  const visit = (dir: string, relDir: string): void => {
    if (limitReached) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
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
      if (snapshot.size >= WORKSPACE_SNAPSHOT_MAX_FILES) {
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
): LoopFileChange[] {
  const after = snapshotWorkspaceFiles(cwd);
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
