import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getLogger } from '../../main/logging/logger';
import type {
  QueueDeleteLeftOutParams, QueueDeleteLeftOutResult, QueueReadReportParams, QueueReadReportResult,
  QueueRemoveParams, QueueRemoveResult,
} from '../../main/remote-node/queue-job-rpc-schemas';
import { git, gitTry } from './queue-git';
import type { QueueJobEnv } from './queue-job-env';
import { isJobWorktree, passesThroughLink, pathPresent } from './queue-job-folder';
import { resolveInside } from './queue-job-paths';
import { deleteOlderPacks } from './queue-job-collect';
import { isProvisionedPath, readProvisioned } from './queue-provisioned';
import type { QueueRepoStore } from './queue-repo-store';

const logger = getLogger('QueueJobCleanup');
const MAX_REPORT_BYTES = 1024 * 1024;

/**
 * This turn's report file only. Every other entry in the job's report folder is deleted, so a file from another
 * turn is never read, and a link is never followed.
 */
export async function readReport(env: QueueJobEnv, params: QueueReadReportParams): Promise<QueueReadReportResult> {
  const folder = env.paths.reportFolder(params.jobId);
  const keep = `${params.turnId}.json`;
  let names: string[];
  try { names = await fs.readdir(folder); } catch { return { text: null }; }
  for (const name of names) {
    if (name !== keep) await fs.rm(path.join(folder, name), { recursive: true, force: true });
  }
  const file = path.join(folder, keep);
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat) return { text: null };
  if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) {
    if (!stat.isFile()) await fs.rm(file, { recursive: true, force: true });
    logger.warn('A queue report file was not a plain file of a sensible size, and counts as no report', { jobId: params.jobId });
    return { text: null };
  }
  return { text: await fs.readFile(file, 'utf8') };
}

/**
 * Delete exactly the named files from the job folder: this Mac's save left them out of the commit (planning files
 * it moved), and `git reset --hard` keeps untracked files. Anything outside the folder, behind a link, a
 * directory, tracked by git, provisioned, or inside `.git` is skipped and listed.
 */
export async function deleteLeftOut(env: QueueJobEnv, params: QueueDeleteLeftOutParams): Promise<QueueDeleteLeftOutResult> {
  return env.mutex.run(`job:${params.jobId}`, async () => {
    const folder = env.paths.jobFolder(params.branch);
    const bare = env.paths.bareRepo(params.project);
    const deleted: string[] = [];
    const skipped: string[] = [];
    if (!await isJobWorktree(folder, bare)) return { deleted, skipped: [...params.files] };
    const provisioned = await readProvisioned(folder);
    const tracked = new Set((await git(['ls-files', '-z'], folder)).split('\0').filter(Boolean).map(entry => entry.toLowerCase()));
    for (const relative of params.files) {
      const target = resolveInside(folder, relative);
      const insideGit = relative.split('/')[0]?.toLowerCase() === '.git';
      if (!target || insideGit || isProvisionedPath(provisioned, relative) || tracked.has(relative.toLowerCase())
        || await passesThroughLink(folder, relative.split('/').slice(0, -1).join('/') || '.')) {
        skipped.push(relative);
        continue;
      }
      const stat = await fs.lstat(target).catch(() => null);
      if (stat?.isDirectory()) { skipped.push(relative); continue; }
      if (stat) await fs.unlink(target);
      deleted.push(relative); // already gone counts as deleted: the call can be repeated
    }
    return { deleted, skipped };
  });
}

/**
 * Take the job off this computer: job folder, planning folder, report folder, the job's references and its packs.
 * The bare repository and the installed checkout stay (the next job sends only what is new), and the job's branch
 * stays so a job sent again is reattached. Safe to repeat, and for a job this computer never saw. Returns
 * `removed: false` only when a session of this worker is still in one of the folders, which are then left alone.
 */
export function removeJob(env: QueueJobEnv, repos: QueueRepoStore, params: QueueRemoveParams): Promise<QueueRemoveResult> {
  return env.mutex.run(`job:${params.jobId}`, async () => {
    const folder = env.paths.jobFolder(params.branch);
    const planning = env.paths.planningFolder(params.jobId);
    const reports = env.paths.reportFolder(params.jobId);
    if (env.folders.hasInstanceInFolders([folder, planning, reports])) return { removed: false };
    env.folders.unregisterQueueJobFolders(folder);
    const bare = env.paths.bareRepo(params.project);
    const repoExists = await repos.exists(params.project);
    const failures: string[] = [];
    const attempt = async (what: string, action: () => Promise<void>): Promise<void> => {
      try { await action(); } catch (error) { failures.push(`${what}: ${error instanceof Error ? error.message : String(error)}`); }
    };
    await attempt('job folder', () => removeWorktreeFolder(bare, folder, repoExists));
    await attempt('planning folder', () => fs.rm(planning, { recursive: true, force: true }));
    await attempt('report folder', () => fs.rm(reports, { recursive: true, force: true }));
    await attempt('job records', () => fs.rm(env.paths.stateDir(params.jobId), { recursive: true, force: true }));
    await attempt('packs', () => deleteOlderPacks(env, params.jobId));
    if (repoExists) await attempt('references', () => deleteJobRefs(bare, params.jobId));
    if (failures.length > 0) throw new Error(`Some of the job could not be removed from this computer (${failures.join('; ')}).`);
    return { removed: true };
  });
}

/** Remove a checkout of the project's repository: git first, then the folder itself if git could not. */
export async function removeWorktreeFolder(bare: string, folder: string, repoExists: boolean): Promise<void> {
  if (!await pathPresent(folder)) {
    if (repoExists) await git(['worktree', 'prune'], bare);
    return;
  }
  if (repoExists && await isJobWorktree(folder, bare)) {
    await gitTry(['worktree', 'remove', '--force', folder], bare, { timeoutMs: 5 * 60_000 });
  }
  await fs.rm(folder, { recursive: true, force: true }); // links are removed, not followed
  if (repoExists) await git(['worktree', 'prune'], bare);
}

async function deleteJobRefs(bare: string, jobId: string): Promise<void> {
  const listed = await git(['for-each-ref', '--format=%(refname)', `refs/queue/${jobId}/`], bare);
  const refs = listed.split('\n').map(line => line.trim()).filter(Boolean);
  if (refs.length === 0) return;
  await git(['update-ref', '--stdin'], bare, { input: `${refs.map(ref => `delete ${ref}`).join('\n')}\n` });
}
