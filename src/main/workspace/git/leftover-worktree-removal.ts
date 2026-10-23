import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { LeftoverRemovalPreview, LeftoverWorktreeRow, WorktreeLeftoversPreviewPayload,
  WorktreeLeftoversRemovePayload } from '@contracts/schemas/workspace-tools';
import { CleanupTicketStore } from '../../storage/cleanup-ticket';
import { isInsideOrEqual, pathCompareKey } from '../../util/path-helpers';
import { buildLeftoverWorktreeReport, type LeftoverReportDependencies } from './leftover-worktree-report';
import { deleteLocalBranchIfPresent, removeManagedWorktreeDirectory, verifyManagedWorktreeOwnership } from './worktree-cleanup';
import { getGitWriteQueue } from './git-write-queue';
import { gitExec } from './git-exec';
import { LeftoverWorktreeArchiveService, worktreeFingerprint } from './leftover-worktree-archive';
import { checkWorktreeProcesses } from './leftover-worktree-processes';

async function verifyPath(repoRoot: string, target: string): Promise<void> {
  const root = await realpath(repoRoot);
  const folder = resolve(target);
  const base = join(root, '.worktrees');
  if (!isInsideOrEqual(base, folder) || pathCompareKey(base) === pathCompareKey(folder)) {
    throw new Error('Only a recorded folder inside the managed .worktrees directory may be removed');
  }
  let ancestor = root;
  for (const part of relative(root, folder).split(sep)) {
    ancestor = join(ancestor, part);
    if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('Symlink paths cannot be removed');
  }
  if (pathCompareKey(await realpath(folder)) !== pathCompareKey(folder)) throw new Error('Folder path changed identity');
}

function binding(row: LeftoverWorktreeRow, action: WorktreeLeftoversPreviewPayload['action']) {
  const state = { repoRoot: row.repoRoot, path: row.path, branch: row.branch, tip: row.tip,
    createdBy: row.createdBy, owner: row.owner, inUse: row.inUse, leftover: row.leftover,
    dirtyCount: row.dirtyCount, patchCount: row.patchCount, fileCount: row.fileCount,
    mergedIntoMain: row.mergedIntoMain, ahead: row.ahead, behind: row.behind,
    unpushedCount: row.unpushedCount, processChecked: row.processChecked, liveProcess: row.liveProcess };
  return { target: JSON.stringify([row.repoRoot, row.path, action]),
    itemsHash: createHash('sha256').update(JSON.stringify(state)).digest('hex') };
}

/** Preview tickets and the final fresh-state read share one service instance. */
export class LeftoverWorktreeRemoval {
  private get archives(): LeftoverWorktreeArchiveService {
    if (!this.deps.archiveRoot) throw new Error('Private recovery archive storage is unavailable');
    return new LeftoverWorktreeArchiveService(this.deps.archiveRoot);
  }
  constructor(private readonly deps: LeftoverReportDependencies,
    private readonly tickets = new CleanupTicketStore()) {}

  private async freshRow(input: WorktreeLeftoversPreviewPayload): Promise<LeftoverWorktreeRow> {
    if (input.action === 'restore-folder') {
      if (!input.archiveId) throw new Error('Choose a recovery archive first');
      if (this.deps.owners().some(o => pathCompareKey(o.path) === pathCompareKey(input.path) && o.inUse)
        || this.deps.liveSessions().some(s => isInsideOrEqual(input.path, s.cwd))) {
        throw new Error('This work folder still has an active owner');
      }
      return this.archives.recoveryRow(input.repoRoot, input.archiveId, input.path);
    }
    await verifyPath(input.repoRoot, input.path);
    const report = await buildLeftoverWorktreeReport(input.repoRoot, this.deps);
    const row = report.rows.find((r) => pathCompareKey(r.path) === pathCompareKey(input.path));
    if (!row || !(input.action === 'archive-and-remove' ? row.archivableByHarness : row.removableByHarness) || row.createdBy !== 'harness' || !row.branch) {
      throw new Error(row?.reason ?? 'Folder is not a removable Harness folder');
    }
    if (input.action === 'remove-folder-and-branch' && !row.mergedIntoMain) {
      throw new Error('Your main copy does not contain this branch. Keep its branch or explicitly discard its saved work.');
    }
    if (input.action !== 'remove-folder' && input.action !== 'archive-and-remove' && row.branch === 'main') throw new Error('The main branch must be kept');
    if (input.action !== 'remove-folder' && input.action !== 'archive-and-remove' && report.rows.some((other) => other.path !== row.path && other.branch === row.branch)) {
      throw new Error('Another folder also uses this branch. Keep the branch.');
    }
    return row;
  }

  async previewLeftoverRemoval(input: WorktreeLeftoversPreviewPayload): Promise<LeftoverRemovalPreview> {
    const row = await this.freshRow(input);
    const consequence = input.action === 'restore-folder'
      ? `Recreate ${row.path} from its private recovery archive, including tracked, untracked and ignored files. It opens detached at the original saved change; staged status is not restored. Your archive remains available.`
      : input.action === 'archive-and-remove'
      ? `Archive every file in ${row.path}, including unsaved, untracked and ignored files, then remove the folder. Keep its branch and a Git recovery ref. The private archive is kept outside the repository; disk space used by the compressed archive is retained. Restore is available below.`
      : input.action === 'remove-folder'
      ? `Remove ${row.path}. The saved work stays on its branch (${row.branch}); the folder can be recreated from that branch. Files not saved in Git, including ignored files, are removed and cannot be brought back.`
      : input.action === 'discard-saved-work'
        ? `Remove ${row.path} and its branch (${row.branch}). The saved work (${row.patchCount} saved changes, ${row.fileCount} files) is deleted and cannot be brought back. Your main copy and all other branches stay unchanged.`
        : `Remove ${row.path} and its branch (${row.branch}). The saved work is already in your main copy and stays there. Files not saved in Git, including ignored files, cannot be brought back. All other branches stay unchanged.`;
    const state = binding(row, input.action);
    if (input.action === 'archive-and-remove') state.itemsHash += await worktreeFingerprint(row.path);
    if (input.archiveId) state.target += input.archiveId;
    return { previewId: this.tickets.issueTicket(state), action: input.action, archiveId: input.archiveId, row, consequence };
  }

  async runLeftoverRemoval(input: WorktreeLeftoversRemovePayload): Promise<{ path: string; branchKept: boolean }> {
    return getGitWriteQueue().enqueue('leftover-worktree-remove', async () => {
      const row = await this.freshRow(input);
      const state = binding(row, input.action);
      if (input.action === 'archive-and-remove') state.itemsHash += await worktreeFingerprint(row.path);
      if (input.archiveId) state.target += input.archiveId;
      this.tickets.consumeTicket(input.previewId, state);
      if (input.action === 'restore-folder') {
        await this.archives.restore(row.repoRoot, input.archiveId!, row.path);
        return { path: row.path, branchKept: true };
      }
      if (input.action === 'discard-saved-work' && input.discardSavedWork !== true) {
        throw new Error('Discarding saved work requires explicit confirmation');
      }
      const branch = row.branch;
      if (!branch) throw new Error('Folder has no local branch');
      const params = { repoRoot: row.repoRoot, worktreePath: row.path, baseDir: '.worktrees', expectedBranch: branch };
      if (!(await verifyManagedWorktreeOwnership(params))) throw new Error('Managed folder ownership changed');
      const [status, tip, branchTip] = await Promise.all([
        gitExec(['--no-optional-locks', 'status', '--porcelain'], row.path),
        gitExec(['--no-optional-locks', 'rev-parse', 'HEAD'], row.path),
        gitExec(['--no-optional-locks', 'rev-parse', `refs/heads/${branch}`], row.repoRoot),
      ]);
      if ((status && input.action !== 'archive-and-remove') || tip !== row.tip || branchTip !== row.tip) throw new Error('Folder changed since you looked. Review again.');
      const fingerprint = input.action === 'archive-and-remove' ? await worktreeFingerprint(row.path) : null;
      if (fingerprint) await this.archives.prepare(row, fingerprint);
      await verifyPath(row.repoRoot, row.path);
      const canonical = (path: string) => realpath(path).catch(() => resolve(path));
      const [owners, sessions] = await Promise.all([
        Promise.all(this.deps.owners().filter((owner) => owner.inUse).map((owner) => canonical(owner.path))),
        Promise.all(this.deps.liveSessions().map((session) => canonical(session.cwd))),
      ]);
      if (owners.some((path) => pathCompareKey(path) === pathCompareKey(row.path))
        || sessions.some((path) => isInsideOrEqual(row.path, path))) {
        throw new Error('This folder is now in use. Review again after its owner ends.');
      }
      const processes = await (this.deps.processCheck ?? checkWorktreeProcesses)(row.path);
      if (!processes.checked || processes.live) throw new Error('Live processes could not be ruled out. Nothing was removed');
      if (fingerprint && await worktreeFingerprint(row.path) !== fingerprint) throw new Error('Folder changed during archival. Nothing was removed');
      if (await gitExec(['rev-parse', 'HEAD'], row.path) !== row.tip
        || await gitExec(['rev-parse', `refs/heads/${branch}`], row.repoRoot) !== row.tip) {
        throw new Error('Folder branch changed during archival. Nothing was removed');
      }
      await removeManagedWorktreeDirectory({ ...params, alreadyQueued: true });
      if (input.action !== 'remove-folder' && input.action !== 'archive-and-remove') {
        await deleteLocalBranchIfPresent(row.repoRoot, branch, input.action === 'discard-saved-work'
          ? { allowUnmerged: true, expectedTip: row.tip }
          : { mergedIntoBranch: 'main', expectedTip: row.tip }, true);
      }
      return { path: row.path, branchKept: input.action === 'remove-folder' || input.action === 'archive-and-remove' };
    }, { retry: { maxAttempts: 1 } });
  }
}
