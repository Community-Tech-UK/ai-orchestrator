import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorkspaceObservationCoverage } from './loop-workspace-snapshot';
import { codeIndexDirectoryIgnoreNames } from '../codemem/code-index-ignores';

export interface WorkspaceRepositoryDiscovery {
  roots: string[];
  coverage: WorkspaceObservationCoverage;
  authoritativeRoot: boolean;
  reason?: string;
}

export interface WorkspaceRepositoryDiscoveryOptions {
  maxDirectories?: number;
}

const IGNORED_DIRECTORIES = new Set([
  ...codeIndexDirectoryIgnoreNames(),
  '.kotlin',
  'bin',
  'build-device',
  'build-simulator',
]);

function containingGitRoot(workspace: string): string | null {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return result.status === 0 && result.stdout.trim()
    ? path.resolve(result.stdout.trim())
    : null;
}

export function discoverWorkspaceRepositories(
  workspaceDir: string,
  options: WorkspaceRepositoryDiscoveryOptions = {},
): WorkspaceRepositoryDiscovery {
  const workspace = path.resolve(workspaceDir);
  try {
    if (!fs.statSync(workspace).isDirectory()) {
      return { roots: [], coverage: 'failed', authoritativeRoot: false, reason: 'workspace root is not a directory' };
    }
  } catch {
    return { roots: [], coverage: 'failed', authoritativeRoot: false, reason: 'workspace root could not be read' };
  }

  const containing = containingGitRoot(workspace);
  if (containing) {
    return { roots: [containing], coverage: 'complete', authoritativeRoot: true };
  }

  const maxDirectories = options.maxDirectories ?? 5_000;
  const queue = [workspace];
  const roots: string[] = [];
  let visited = 0;
  let skipped = 0;
  let truncated = false;

  while (queue.length > 0) {
    const dir = queue.shift()!;
    if (visited >= maxDirectories) {
      truncated = true;
      break;
    }
    visited += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      skipped += 1;
      continue;
    }
    if (entries.some((entry) => entry.name === '.git')) {
      roots.push(dir);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      queue.push(path.join(dir, entry.name));
    }
  }

  const coverage: WorkspaceObservationCoverage = truncated || skipped > 0 ? 'partial' : 'complete';
  const reasons = [
    truncated ? `repository discovery directory limit reached (${maxDirectories})` : '',
    skipped > 0 ? `${skipped} director${skipped === 1 ? 'y' : 'ies'} unreadable` : '',
  ].filter(Boolean);
  return {
    roots: roots.sort(),
    coverage,
    authoritativeRoot: false,
    ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
  };
}
