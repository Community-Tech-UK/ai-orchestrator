import * as fs from 'fs/promises';
import * as path from 'path';

const DEFAULT_SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.worktrees',
  'node_modules',
  'dist',
  'build',
  '.angular',
  'coverage',
  '.next',
  '.nuxt',
  'target',
]);

export interface CountRepoFilesOptions {
  stopAfter?: number;
  skipDirs?: ReadonlySet<string>;
}

export async function countRepoFiles(
  root: string,
  options: CountRepoFilesOptions = {},
): Promise<number> {
  const stopAfter = options.stopAfter ?? Number.POSITIVE_INFINITY;
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS;
  const queue = [root];
  let count = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          queue.push(path.join(current, entry.name));
        }
        continue;
      }

      if (entry.isFile()) {
        count += 1;
        if (count > stopAfter) {
          return count;
        }
      }
    }
  }

  return count;
}
