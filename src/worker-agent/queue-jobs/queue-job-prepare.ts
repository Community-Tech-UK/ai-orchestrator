import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getLogger } from '../../main/logging/logger';
import type { QueuePrepareParams, QueuePrepareResult } from '../../main/remote-node/queue-job-rpc-schemas';
import { git, gitText, gitTry, GIT_LONG_TIMEOUT_MS } from './queue-git';
import { QueueJobRefusal } from './queue-job-errors';
import type { QueueJobEnv } from './queue-job-env';
import { provisionJobFolderDependencies } from './queue-job-dependencies';
import { currentBranch, isJobWorktree, pathPresent } from './queue-job-folder';
import type { QueueInstalledCheckout } from './queue-installed-checkout';
import { writePlanningFolder } from './queue-planning-folder';
import { listUntracked, readProvisioned, readProvisionedRecord, writeProvisioned } from './queue-provisioned';
import { queueRefName, type QueueRepoStore } from './queue-repo-store';

const logger = getLogger('QueueJobPrepare');

export interface QueuePrepareContext {
  env: QueueJobEnv;
  repos: QueueRepoStore;
  installed: QueueInstalledCheckout;
}

/**
 * Make the job's folders ready for one worker turn: the job folder at `commit` on the job's branch (a new branch
 * through `createWorktree`; an existing branch is reattached, never deleted, and moved to `commit`), the planning
 * folder filled with the documents sent, the report folder, and the three folders allowed for that one session.
 */
export function prepareJob(context: QueuePrepareContext, params: QueuePrepareParams): Promise<QueuePrepareResult> {
  return context.env.mutex.run(`job:${params.jobId}`, () => prepareLocked(context, params));
}

async function prepareLocked(context: QueuePrepareContext, params: QueuePrepareParams): Promise<QueuePrepareResult> {
  const { env, repos, installed } = context;
  const { project, jobId, branch, commit } = params;
  const sent = await repos.refValue(project, queueRefName(jobId, 'sent'));
  if (sent !== commit) {
    throw new QueueJobRefusal('no-copy', 'This computer does not hold that version of the job\'s code, so the job folder was not made.');
  }
  const start = await repos.refValue(project, queueRefName(jobId, 'start')) ?? commit;
  const bare = env.paths.bareRepo(project);
  const folder = env.paths.jobFolder(branch);
  const branchExists = await gitTry(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], bare) !== null;
  // The folder's setup links dependencies from the installed checkout, so no other job may reinstall it meanwhile.
  const checkout = await installed.use(project, start, async current => {
    if (branchExists) await reattach(env, { bare, folder, branch, commit, installedPath: current.path });
    else await createNew(env, { bare, folder, jobId, branch, commit, installedPath: current.path });
    return current;
  });

  await writePlanningFolder(env, jobId, params.documents);
  const reportFolder = env.paths.reportFolder(jobId);
  await fs.mkdir(reportFolder, { recursive: true });
  const planningFolder = env.paths.planningFolder(jobId);
  env.folders.registerQueueJobFolders({ jobFolder: folder, planningFolder, reportFolder });
  logger.info('Prepared a queue job folder', { jobId, reattached: branchExists, installed: checkout.installed });
  return {
    jobFolder: folder,
    planningFolder,
    reportFolder,
    reportFile: env.paths.reportFile(jobId, params.turnId),
    provisioned: await readProvisioned(folder),
    installed: checkout.installed,
  };
}

interface FolderRequest {
  bare: string;
  folder: string;
  branch: string;
  commit: string;
  installedPath: string;
}

async function createNew(env: QueueJobEnv, request: FolderRequest & { jobId: string }): Promise<void> {
  if (await pathPresent(request.folder)) {
    throw new Error('A folder is already at this job\'s place but its branch is missing, so it was left alone.');
  }
  const created = await env.createWorktree({
    jobId: request.jobId, branch: request.branch, commit: request.commit, installedPath: request.installedPath,
  });
  if (path.resolve(created) !== path.resolve(request.folder)) {
    throw new Error('The job folder was made somewhere other than the queue\'s folder; it was not used.');
  }
  // Everything untracked straight after setup is setup's, and stays out of every collect (as on the Mac).
  await writeProvisioned(request.folder, await listUntracked(request.folder));
}

async function reattach(env: QueueJobEnv, request: FolderRequest): Promise<void> {
  const { bare, folder, branch, commit, installedPath } = request;
  await git(['worktree', 'prune'], bare);
  if (await pathPresent(folder)) {
    if (!await isJobWorktree(folder, bare) || await currentBranch(folder) !== branch) {
      throw new Error('A folder at this job\'s place is not this job\'s checkout of its branch, so it was left alone.');
    }
    if (!(await dependenciesPresent(folder))) await provisionAndRecord(installedPath, folder, 'add');
  } else {
    await fs.mkdir(path.dirname(folder), { recursive: true });
    await git(['worktree', 'add', folder, branch], bare, { timeoutMs: GIT_LONG_TIMEOUT_MS });
    await provisionAndRecord(installedPath, folder, 'replace');
  }
  // Main has closed the session and collected: the folder moves to what was sent, whatever it held.
  await gitText(['reset', '--hard', commit], folder, { timeoutMs: GIT_LONG_TIMEOUT_MS });
}

async function dependenciesPresent(folder: string): Promise<boolean> {
  return fs.readdir(path.join(folder, 'node_modules')).then(entries => entries.length > 0, () => false);
}

/** Set up dependencies and record what that left untracked, without ever recording the agent's own files. */
async function provisionAndRecord(installedPath: string, folder: string, mode: 'add' | 'replace'): Promise<void> {
  const before = new Set(await listUntracked(folder));
  await provisionJobFolderDependencies(installedPath, folder);
  const after = await listUntracked(folder);
  if (mode === 'replace') {
    await writeProvisioned(folder, after);
    return;
  }
  const added = after.filter(entry => !before.has(entry));
  if (added.length > 0) await writeProvisioned(folder, [...(await readProvisionedRecord(folder) ?? []), ...added]);
}
