import * as fs from 'fs';
import * as path from 'path';

function normalizePath(value: string): string {
  return path.resolve(value);
}

function findGitProjectRoot(
  workingDirectory: string,
  homeDir?: string | null,
): string | null {
  const normalizedWorkingDirectory = normalizePath(workingDirectory);
  const normalizedHomeDir = homeDir ? normalizePath(homeDir) : null;

  let current = normalizedWorkingDirectory;
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }

    if (normalizedHomeDir && current === normalizedHomeDir) {
      return null;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Resolve project-scoped scan roots from the git root down to the current
 * working directory. If no git root is found, fall back to the working
 * directory alone to preserve previous behavior outside repositories.
 */
export function resolveProjectScanRoots(
  workingDirectory: string,
  homeDir?: string | null,
): string[] {
  const normalizedWorkingDirectory = normalizePath(workingDirectory);
  const projectRoot = findGitProjectRoot(normalizedWorkingDirectory, homeDir);
  if (!projectRoot) {
    return [normalizedWorkingDirectory];
  }

  const roots: string[] = [];
  let current = normalizedWorkingDirectory;

  while (true) {
    roots.push(current);
    if (current === projectRoot) {
      break;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return roots.reverse();
}
