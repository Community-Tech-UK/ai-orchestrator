import { lstat, opendir, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { LeftoverWorktreeOwner, LeftoverWorktreeReport, LeftoverWorktreeRow } from '@contracts/schemas/workspace-tools';
import { isInsideOrEqual, pathCompareKey } from '../../util/path-helpers';
import { gitExec } from './git-exec';

export interface RecordedWorktreeOwner extends LeftoverWorktreeOwner {
  path: string;
  repoRoot: string;
}
export interface LeftoverReportDependencies {
  git?: (args: string[], cwd: string) => Promise<string>;
  now?: () => number;
  currentCheckout?: string;
  owners: () => RecordedWorktreeOwner[];
  liveSessions: () => { id: string; cwd: string; status?: string }[];
  size?: (path: string) => Promise<number>;
}
const sizes = new Map<string, { at: number; value: Promise<number> }>();

/** Do not follow symlinks, including the root, when accounting for disk bytes. */
async function folderBytes(path: string): Promise<number> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  const directory = await opendir(path);
  for await (const entry of directory) total += await folderBytes(join(path, entry.name));
  return total;
}
function cachedSize(path: string): Promise<number> {
  const key = pathCompareKey(path);
  const cached = sizes.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  if (sizes.size >= 256) sizes.delete(sizes.keys().next().value as string);
  const value = folderBytes(path).catch((error: unknown) => { sizes.delete(key); throw error; });
  sizes.set(key, { at: Date.now(), value });
  return value;
}

/** NUL output keeps spaces, quotes and newlines in checkout paths unambiguous. */
export function parseLeftoverWorktrees(output: string): { path: string; branch: string | null; tip: string }[] {
  return output.split('\0\0').flatMap((record) => {
    const fields = record.split('\0');
    const path = fields.find((line) => line.startsWith('worktree '))?.slice(9);
    if (!path) return [];
    return [{ path, branch: fields.find((line) => line.startsWith('branch refs/heads/'))?.slice(18) ?? null,
      tip: fields.find((line) => line.startsWith('HEAD '))?.slice(5) ?? '' }];
  });
}

function exitCode(error: unknown): number | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'number'
    ? error.code : undefined;
}

export async function buildLeftoverWorktreeReport(
  repoRoot: string, deps: LeftoverReportDependencies,
): Promise<LeftoverWorktreeReport> {
  const git = (args: string[], cwd = repoRoot) => (deps.git ?? gitExec)(['--no-optional-locks', ...args], cwd);
  const worktrees = parseLeftoverWorktrees(await git(['worktree', 'list', '--porcelain', '-z']));
  const mainRoot = worktrees[0]?.path ?? resolve(repoRoot);
  const canonical = (p: string) => realpath(p).catch(() => resolve(p));
  const ownersByPath = new Map<string, RecordedWorktreeOwner[]>();
  // Owner history is intentionally uncapped; bound filesystem work and index
  // it once instead of scanning that history again for each folder.
  for (const owner of deps.owners()) {
    const key = pathCompareKey(await canonical(owner.path));
    const group = ownersByPath.get(key) ?? [];
    group.push(owner); ownersByPath.set(key, group);
  }
  const sessions: ReturnType<LeftoverReportDependencies['liveSessions']> = [];
  for (const session of deps.liveSessions()) sessions.push({ ...session, cwd: await canonical(session.cwd) });
  const currentCheckout = deps.currentCheckout ? await canonical(deps.currentCheckout) : undefined;
  const now = (deps.now ?? Date.now)();
  const rows: LeftoverWorktreeRow[] = [];
  const errors: LeftoverWorktreeReport['errors'] = [];
  for (const tree of worktrees.slice(1)) {
    const matchingOwners = ownersByPath.get(pathCompareKey(tree.path)) ?? [];
    const recorded = matchingOwners.find((o) => o.inUse) ?? matchingOwners[0];
    const live = sessions.find((s) => isInsideOrEqual(tree.path, s.cwd));
    const inCurrentCheckout = Boolean(currentCheckout && isInsideOrEqual(tree.path, currentCheckout));
    const owner: LeftoverWorktreeOwner | null = live
      ? { kind: 'session', id: live.id, status: live.status ?? 'live', inUse: true }
      : recorded ? { kind: recorded.kind, id: recorded.id, status: recorded.status,
        phase: recorded.phase, inUse: recorded.inUse } : null;
    const inUse = Boolean(inCurrentCheckout || live || matchingOwners.some((o) => o.inUse));
    const createdBy = isInsideOrEqual(join(mainRoot, '.claude', 'worktrees'), tree.path) ? 'claude-code'
      : recorded && isInsideOrEqual(join(mainRoot, '.worktrees'), tree.path) ? 'harness' : 'other';
    try {
      const [status, counts, cherry, stat, date, bytes, mergedIntoMain] = await Promise.all([
        git(['status', '--porcelain=v2', '-z'], tree.path),
        git(['rev-list', '--left-right', '--count', `main...${tree.tip}`]),
        git(['cherry', 'main', tree.tip]),
        git(['diff', '--shortstat', `main...${tree.tip}`]),
        git(['show', '-s', '--format=%ct', tree.tip]),
        (deps.size ?? cachedSize)(tree.path),
        git(['merge-base', '--is-ancestor', tree.tip, 'main']).then(() => true, (error: unknown) => {
          if (exitCode(error) === 1) return false;
          throw error;
        }),
      ]);
      // Rename records have two paths; only fields beginning with a status count.
      const dirtyCount = status.split('\0').filter((part) => /^[12u?] /.test(part)).length;
      const [behind, ahead] = counts.trim().split(/\s+/).map(Number);
      const patchCount = cherry.split('\n').filter((line) => line.startsWith('+ ')).length;
      const fileCount = Number(stat.match(/(\d+) files? changed/)?.[1] ?? 0);
      const lastCommitAt = Number(date) * 1000;
      if (!Number.isFinite(lastCommitAt) || !Number.isFinite(ahead) || !Number.isFinite(behind)) {
        throw new Error('Git returned incomplete folder metadata');
      }
      const ageDays = Math.max(0, Math.floor((now - lastCommitAt) / 86_400_000));
      const leftover = !inUse && ageDays >= 14;
      const reason = inUse ? live ? 'In use by a live session' : inCurrentCheckout ? 'This is the current checkout'
        : owner?.kind === 'queue' ? 'In use by a plan queue item that is still open' : 'In use by a loop that is still open'
        : dirtyCount ? 'Has unsaved changes. Save or review them before removing this folder.'
        : ageDays < 14 ? 'Its newest saved change is less than 14 days old'
        : createdBy === 'claude-code' ? 'Made by Claude Code. Harness will not remove it.'
        : createdBy === 'other' ? 'Not made by a Harness loop. Harness will not remove it.'
        : !tree.branch ? 'This folder has no local branch' : null;
      rows.push({ repoRoot: mainRoot, ...tree, createdBy, owner, inUse, leftover,
        category: inUse ? 'in-use' : patchCount ? 'saved-work' : 'nothing-to-save',
        removableByHarness: !reason, reason, dirtyCount, ahead, behind, patchCount, fileCount,
        mergedIntoMain, lastCommitAt, ageDays, bytes,
        sentence: patchCount ? `Holds ${patchCount} saved change${patchCount === 1 ? '' : 's'} (${fileCount} files) that your main copy does not have.`
          : 'Already in your main copy. Safe to remove once this folder is no longer in use.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ repoRoot: mainRoot, message: `${tree.path}: ${message}` });
      rows.push({ repoRoot: mainRoot, ...tree, createdBy, owner, inUse, leftover: false,
        category: inUse ? 'in-use' : 'saved-work', removableByHarness: false,
        reason: 'Folder details could not be verified. Harness will not remove it.', dirtyCount: 0,
        ahead: 0, behind: 0, patchCount: 0, fileCount: 0, mergedIntoMain: false,
        lastCommitAt: 0, ageDays: 0, bytes: 0, sentence: 'Folder details are unavailable.',
      });
    }
  }
  return { rows, errors };
}
