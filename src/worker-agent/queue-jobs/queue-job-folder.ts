import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gitTry } from './queue-git';

async function realOrResolved(target: string): Promise<string> {
  return fs.realpath(target).catch(() => path.resolve(target));
}

function sameOrInside(candidate: string, folder: string): boolean {
  const fold = process.platform === 'win32' || process.platform === 'darwin';
  const [a, b] = fold ? [candidate.toLowerCase(), folder.toLowerCase()] : [candidate, folder];
  return a === b || a.startsWith(b + path.sep);
}

/** Is there anything at this path (a link counts, and is not followed)? */
export async function pathPresent(target: string): Promise<boolean> {
  return fs.lstat(target).then(() => true, () => false);
}

/**
 * Is `folder` a checkout belonging to this project's bare repository? Its `.git` file names a folder under
 * `<bare>/worktrees`; anything else (a plain folder, another repository's checkout) is not ours to touch.
 */
export async function isJobWorktree(folder: string, bare: string): Promise<boolean> {
  try {
    const text = await fs.readFile(path.join(folder, '.git'), 'utf8');
    const match = /^gitdir:\s*(.+)$/m.exec(text);
    if (!match?.[1]) return false;
    const gitDir = path.resolve(folder, match[1].trim());
    return sameOrInside(await realOrResolved(gitDir), path.join(await realOrResolved(bare), 'worktrees'));
  } catch {
    return false;
  }
}

/** The branch the folder has checked out, or null (detached, or not a checkout). */
export function currentBranch(folder: string): Promise<string | null> {
  return gitTry(['symbolic-ref', '-q', '--short', 'HEAD'], folder);
}

/** Does any part of `relative` (below `base`) go through a link? A link is never followed out of a folder. */
export async function passesThroughLink(base: string, relative: string): Promise<boolean> {
  let current = base;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat) return false;
    if (stat.isSymbolicLink()) return true;
  }
  return false;
}
