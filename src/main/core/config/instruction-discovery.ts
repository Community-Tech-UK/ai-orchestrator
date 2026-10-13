/** Instruction-file discovery: full diagnostic inventory or bounded runtime ancestors. */
import * as fs from 'fs/promises';
import type { Dirent } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getLogger } from '../../logging/logger';

const logger = getLogger('InstructionResolver');

const EXCLUDED_SCAN_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'release',
  '.angular',
  '.worktrees',
  // macOS protected directories — scanning these triggers TCC permission prompts
  'Documents',
  'Desktop',
  'Downloads',
  'Movies',
  'Music',
  'Pictures',
  'Library',
  'Applications',
  '.Trash',
  // Linux common non-project directories
  'snap',
  // Volumes / mounts — avoid removable volume TCC prompts
  'Volumes',
  'mnt',
  'media',
]);


/**
 * Returns true if the given directory is too broad to recursively scan for
 * instruction files.  The home directory and the filesystem root are never
 * real project roots — scanning them triggers macOS TCC permission prompts
 * (Documents, Desktop, removable volumes, etc.) and is extremely slow.
 */
export function isBroadDirectory(directory: string): boolean {
  const resolved = path.resolve(directory);
  const home = os.homedir();
  // Filesystem root ('/' on unix, 'C:\' on Windows)
  if (resolved === path.parse(resolved).root) return true;
  // Home directory
  if (resolved === home) return true;
  // /Volumes on macOS (parent of all mount points)
  if (resolved === '/Volumes') return true;
  return false;
}


async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function collectMatchingFiles(
  directory: string,
  predicate: (absolutePath: string) => boolean,
): Promise<string[]> {
  if (!(await pathExists(directory))) {
    return [];
  }

  const results: string[] = [];
  const queue = [directory];

  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
        logger.debug('Skipping instruction scan directory', {
          directory: current,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      throw error;
    }

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (!EXCLUDED_SCAN_DIRS.has(entry.name)) {
          queue.push(absolutePath);
        }
        continue;
      }

      if (entry.isFile() && predicate(absolutePath)) {
        results.push(absolutePath);
      }
    }
  }

  return results.sort((a, b) => a.localeCompare(b));
}

/**
 * Scoped AGENTS can only apply along an anchor's ancestor chain. Enumerate only
 * those directories, preserving inventory's readability, exact casing and
 * symlink/exclusion rules without walking unrelated project trees.
 */
export async function collectApplicableAgentsFiles(
  projectRoot: string,
  anchors: string[],
): Promise<string[]> {
  const candidates = new Set<string>();
  const directories = new Map<string, Dirent[] | undefined>();
  const readDirectory = async (directory: string): Promise<Dirent[] | undefined> => {
    if (directories.has(directory)) return directories.get(directory);
    let entries: Dirent[] | undefined;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES' && code !== 'EPERM') throw error;
    }
    directories.set(directory, entries);
    return entries;
  };

  for (const anchor of anchors) {
    const relative = path.relative(projectRoot, anchor);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    let current = projectRoot;
    for (const segment of relative.split(path.sep)) {
      if (EXCLUDED_SCAN_DIRS.has(segment)) break;
      const parentEntries = await readDirectory(current);
      if (!parentEntries?.some(entry => entry.name === segment && entry.isDirectory())) break;
      current = path.join(current, segment);
      const entries = await readDirectory(current);
      if (!entries) break;
      if (entries.some(entry => entry.name === 'AGENTS.md' && entry.isFile())) {
        candidates.add(path.join(current, 'AGENTS.md'));
      }
    }
  }

  return [...candidates].sort((a, b) => a.localeCompare(b));
}

