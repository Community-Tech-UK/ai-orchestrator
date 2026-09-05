/**
 * T37 — `.worktreeinclude`: bring gitignored, expensive-to-rebuild paths into a
 * fresh worktree by symlink instead of copying or installing them.
 *
 * The bug this closes: loop isolation was on by default and always passed
 * `skipInstall: true`, so the worktree had no `node_modules`. `npm run verify`
 * then failed on an empty tree, the failure was classified as a *command*
 * failure, and the child was told to go fix tests that were never broken.
 *
 * Hermes solves this with an include list read after `git worktree add`. We do
 * the same, with one deliberate difference for `node_modules`:
 *
 *   **The directory itself is never symlinked — its entries are.** A single
 *   link to the root `node_modules` would drag along this repo's workspace
 *   links (`@ai-orchestrator/contracts` → `../../packages/contracts`), which
 *   would then resolve to the ROOT packages. The worktree would silently build
 *   against the root's package sources, which is precisely the isolation the
 *   worktree exists to provide. Linking entry-by-entry lets the workspace
 *   entries be re-created pointing inside the worktree.
 *
 *   A workspace link is detected by RESOLVING it, not by matching a name.
 *   An earlier version repaired a hard-coded pair of `@ai-orchestrator/*`
 *   names and therefore missed `node_modules/archiver` — an unscoped workspace
 *   link to `packages/archiver-compat` — silently breaking isolation for that
 *   package. Any entry whose target lands inside the repo's own `packages/`
 *   is re-created against the worktree's copy.
 *
 * Known trade-off, accepted: a package that writes inside `node_modules` at
 * runtime writes into the root's copy. That is cheaper and far more predictable
 * than a per-worktree install, and the native `.node` binaries are shared from
 * root so the Electron ABI is correct by construction.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { getLogger } from '../../logging/logger';
import { repairWorkspaceLinks } from './worktree-deps';

const logger = getLogger('WorktreeInclude');

export const WORKTREE_INCLUDE_FILE = '.worktreeinclude';

export interface WorktreeIncludeEntryResult {
  entry: string;
  status: 'linked' | 'copied' | 'missing' | 'failed';
  reason?: string;
}

export interface WorktreeIncludeResult {
  /** No listed entry failed outright. See {@link worktreeHasDependencies}. */
  ok: boolean;
  entries: WorktreeIncludeEntryResult[];
}

/**
 * Did the worktree actually end up with dependencies?
 *
 * `ok` alone is NOT the right question for the caller. A `missing` entry is not
 * a failure — an include list may name optional paths — but if the one path the
 * list exists for (`node_modules`) was missing at the root, the worktree is
 * still empty and the caller MUST fall through to a real provision. Believing
 * `ok` here is how the T37 bug (a loop verifying against an empty tree) would
 * come straight back on a fresh clone.
 */
export async function worktreeHasDependencies(worktreePath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(path.join(worktreePath, 'node_modules'));
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * Read the include list. Comments (`#`) and blank lines are ignored; a trailing
 * slash is dropped so `node_modules/` and `node_modules` mean the same thing.
 * Returns `[]` when the file is absent — the caller then falls back to
 * `provisionWorktreeDependencies`.
 */
export async function readWorktreeIncludes(repoRoot: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(repoRoot, WORKTREE_INCLUDE_FILE), 'utf8');
  } catch {
    return [];
  }
  const entries: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim().replace(/\/+$/, '');
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Never let an include list escape the repository or rewrite the checkout.
    if (path.isAbsolute(trimmed) || trimmed.split(/[\\/]/).includes('..') || trimmed === '.git') {
      logger.warn('WorktreeInclude: refusing an unsafe include entry', { entry: trimmed });
      continue;
    }
    if (!entries.includes(trimmed)) entries.push(trimmed);
  }
  return entries;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows without Developer Mode cannot create file symlinks. Directories can
 * use a junction; individual files fall back to a copy.
 */
async function linkOrCopy(src: string, dest: string, isDirectory: boolean): Promise<'linked' | 'copied'> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (process.platform === 'win32') {
    if (isDirectory) {
      await fs.symlink(src, dest, 'junction');
      return 'linked';
    }
    await fs.copyFile(src, dest);
    return 'copied';
  }
  await fs.symlink(src, dest);
  return 'linked';
}

/**
 * Link `node_modules` entry-by-entry, then re-point the workspace links at the
 * worktree's own `packages/` so isolation survives.
 */
async function linkNodeModules(repoRoot: string, worktreePath: string, entry: string): Promise<WorktreeIncludeEntryResult> {
  const src = path.join(repoRoot, entry);
  const dest = path.join(worktreePath, entry);
  if (!(await pathExists(src))) return { entry, status: 'missing' };
  if (await pathExists(dest)) return { entry, status: 'linked', reason: 'already present' };

  await fs.mkdir(dest, { recursive: true });
  await linkDirectoryEntries(repoRoot, worktreePath, src, dest);
  await repairWorkspaceLinks(worktreePath);
  return { entry, status: 'linked' };
}

/**
 * Directories inside `node_modules` that must be descended into rather than
 * linked wholesale, because their CHILDREN can be workspace links: scope
 * directories (`@scope/`) and `.bin` (whose shims point at package files).
 */
function mustDescend(name: string): boolean {
  return name.startsWith('@') || name === '.bin';
}

async function linkDirectoryEntries(
  repoRoot: string,
  worktreePath: string,
  srcDir: string,
  destDir: string,
): Promise<void> {
  for (const name of await fs.readdir(srcDir)) {
    const childSrc = path.join(srcDir, name);
    const childDest = path.join(destDir, name);
    const stat = await fs.lstat(childSrc);

    // A link into the repo's own `packages/` is a workspace link: re-create it
    // against the WORKTREE's copy, or the isolated build compiles root sources.
    if (stat.isSymbolicLink() && await resolvesIntoWorkspacePackages(repoRoot, childSrc)) {
      await createWorktreeRelativeLink(repoRoot, worktreePath, childSrc, childDest);
      continue;
    }

    if (stat.isDirectory() && mustDescend(name)) {
      await fs.mkdir(childDest, { recursive: true });
      await linkDirectoryEntries(repoRoot, worktreePath, childSrc, childDest);
      continue;
    }

    await linkOrCopy(childSrc, childDest, stat.isDirectory());
  }
}

/** Does this symlink resolve inside `<repoRoot>/packages/`? */
async function resolvesIntoWorkspacePackages(repoRoot: string, linkPath: string): Promise<boolean> {
  try {
    const target = await fs.readlink(linkPath);
    const resolved = path.resolve(path.dirname(linkPath), target);
    const packagesRoot = path.join(path.resolve(repoRoot), 'packages');
    return resolved === packagesRoot || resolved.startsWith(packagesRoot + path.sep);
  } catch {
    return false;
  }
}

/** Re-create a workspace link so it points at the worktree's own package. */
async function createWorktreeRelativeLink(
  repoRoot: string,
  worktreePath: string,
  srcLink: string,
  destLink: string,
): Promise<void> {
  const target = await fs.readlink(srcLink);
  const resolved = path.resolve(path.dirname(srcLink), target);
  const relativeToRepo = path.relative(path.resolve(repoRoot), resolved);
  const worktreeTarget = path.join(worktreePath, relativeToRepo);
  await fs.mkdir(path.dirname(destLink), { recursive: true });
  await fs.rm(destLink, { recursive: true, force: true });
  if (process.platform === 'win32') {
    await fs.symlink(worktreeTarget, destLink, 'junction');
    return;
  }
  await fs.symlink(path.relative(path.dirname(destLink), worktreeTarget), destLink);
}

/**
 * Apply the include list to a freshly-added worktree. Never throws: a failed
 * entry is reported so the caller can fall back to a real provision.
 */
export async function applyWorktreeIncludes(
  repoRoot: string,
  worktreePath: string,
  entries: readonly string[],
): Promise<WorktreeIncludeResult> {
  const results: WorktreeIncludeEntryResult[] = [];

  for (const entry of entries) {
    try {
      if (entry === 'node_modules') {
        results.push(await linkNodeModules(repoRoot, worktreePath, entry));
        continue;
      }
      const src = path.join(repoRoot, entry);
      const dest = path.join(worktreePath, entry);
      if (!(await pathExists(src))) {
        results.push({ entry, status: 'missing' });
        continue;
      }
      if (await pathExists(dest)) {
        results.push({ entry, status: 'linked', reason: 'already present' });
        continue;
      }
      const stat = await fs.lstat(src);
      const how = await linkOrCopy(src, dest, stat.isDirectory());
      results.push({ entry, status: how });
    } catch (err) {
      results.push({
        entry,
        status: 'failed',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // `missing` is not a failure — an include list may name optional paths. Only
  // an entry we tried and could not create means "fall back".
  const ok = results.every((r) => r.status !== 'failed');
  if (!ok) {
    logger.warn('WorktreeInclude: include list did not apply cleanly', {
      worktreePath,
      failed: results.filter((r) => r.status === 'failed'),
    });
  }
  return { ok, entries: results };
}
