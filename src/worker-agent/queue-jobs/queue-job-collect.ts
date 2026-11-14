import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getLogger } from '../../main/logging/logger';
import {
  QUEUE_PACK_CHUNK_BYTES,
  type QueueCollectParams, type QueueCollectResult, type QueueFetchPackParams, type QueueFetchPackResult,
} from '../../main/remote-node/queue-job-rpc-schemas';
import { git, gitText, gitTry, GIT_LONG_TIMEOUT_MS, QUEUE_COMMIT_IDENTITY } from './queue-git';
import { QueueJobRefusal } from './queue-job-errors';
import type { QueueJobEnv } from './queue-job-env';
import { currentBranch, isJobWorktree } from './queue-job-folder';
import { packPrefix } from './queue-job-paths';
import { diffPlanningFolder } from './queue-planning-folder';
import { readProvisioned, workPathspec } from './queue-provisioned';
import { queueRefName, type QueueRepoStore } from './queue-repo-store';

const logger = getLogger('QueueJobCollect');

export interface QueueCollectContext {
  env: QueueJobEnv;
  repos: QueueRepoStore;
}

/**
 * Close-safe collect. Nothing here moves the job's branch or its folder: the agent's work is recorded as a commit
 * on a side reference (`refs/queue/<jobId>/collected`), built through a temporary index, whose parent is the last
 * commit this Mac sent. A refusal comes back as data with a reason in plain words.
 */
export function collectJob(context: QueueCollectContext, params: QueueCollectParams): Promise<QueueCollectResult> {
  return context.env.mutex.run(`job:${params.jobId}`, async () => {
    try {
      return await collectLocked(context, params);
    } catch (error) {
      if (error instanceof QueueJobRefusal) return { refused: { reason: error.reason, message: error.message } };
      throw error;
    }
  });
}

async function collectLocked({ env, repos }: QueueCollectContext, params: QueueCollectParams): Promise<QueueCollectResult> {
  const { project, jobId, branch, expectedParent } = params;
  const folder = env.paths.jobFolder(branch);
  const planning = env.paths.planningFolder(jobId);
  const reportFolder = env.paths.reportFolder(jobId);
  if (env.folders.hasInstanceInFolders([folder, planning, reportFolder])) {
    throw new QueueJobRefusal('session-running', 'The agent\'s session on that computer is still running, so its work was not collected.');
  }
  const bare = env.paths.bareRepo(project);
  const sent = await repos.refValue(project, queueRefName(jobId, 'sent'));
  if (!sent) throw new QueueJobRefusal('no-copy', 'That computer has no copy of this job\'s code.');
  if (!await isJobWorktree(folder, bare) || !await fs.stat(planning).then(stat => stat.isDirectory(), () => false)) {
    throw new QueueJobRefusal('not-prepared', 'That computer has no job folder for this job (it was removed or never made).');
  }
  if (sent !== expectedParent) {
    throw new QueueJobRefusal('wrong-parent', 'The last version that computer holds for this job is not the one this Mac expected, so the work was not collected.');
  }
  const head = await gitText(['rev-parse', 'HEAD'], folder);
  const tip = await gitTry(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], bare);
  if (head !== expectedParent || tip !== expectedParent || await currentBranch(folder) !== branch) {
    throw new QueueJobRefusal('agent-committed', 'The agent made a commit (or moved the folder to another one) on that computer. Its work is kept there, and was not collected.');
  }

  // Planning files first: a refusal leaves no commit or pack behind.
  const planningChanges = await diffPlanningFolder(env, jobId);
  await deleteOlderPacks(env, jobId);
  const commit = await snapshotCommit(env, { jobId, folder, bare, parent: expectedParent });
  const pack = await makePack(env, { jobId, bare, commit, parent: expectedParent });
  logger.info('Collected a queue job', { jobId, packChunks: pack.chunks, documents: planningChanges.documents.length });
  return { commit, packId: pack.packId, packChunks: pack.chunks, documents: planningChanges.documents, deleted: planningChanges.deleted };
}

/** Everything the agent changed, minus what setup left, as a commit on a side reference. */
async function snapshotCommit(env: QueueJobEnv, request: { jobId: string; folder: string; bare: string; parent: string }): Promise<string> {
  const { jobId, folder, bare, parent } = request;
  const gitDir = await gitText(['rev-parse', '--absolute-git-dir'], folder);
  await fs.mkdir(env.paths.stateDir(jobId), { recursive: true });
  const tempIndex = path.join(env.paths.stateDir(jobId), `index-${randomUUID()}`);
  const indexEnv = { GIT_INDEX_FILE: tempIndex };
  try {
    // Start from the folder's own index so unchanged files are not read again; fall back to the parent's tree.
    await fs.copyFile(path.join(gitDir, 'index'), tempIndex).catch(async () => {
      await git(['read-tree', parent], folder, { env: indexEnv });
    });
    await git(['add', '-A', ...workPathspec(await readProvisioned(folder))], folder, { env: indexEnv, timeoutMs: GIT_LONG_TIMEOUT_MS });
    const tree = await gitText(['write-tree'], folder, { env: indexEnv });
    const commit = await gitText(['commit-tree', tree, '-p', parent, '-m', `Queue collect: ${jobId}`], folder, { env: { ...QUEUE_COMMIT_IDENTITY } });
    await git(['update-ref', queueRefName(jobId, 'collected'), commit], bare);
    return commit;
  } finally {
    await fs.rm(tempIndex, { force: true });
  }
}

/** A thin pack of the collected commit against what this Mac already holds, kept in a temp folder under a pack id. */
async function makePack(env: QueueJobEnv, request: { jobId: string; bare: string; commit: string; parent: string }): Promise<{ packId: string; chunks: number }> {
  const packId = `${packPrefix(request.jobId)}-${randomUUID()}`;
  await fs.mkdir(env.paths.packsDir, { recursive: true });
  const file = env.paths.packFile(packId);
  await git(['pack-objects', '--thin', '--revs', '--stdout'], request.bare, {
    input: `${request.commit}\n^${request.parent}\n`, stdoutFile: file, timeoutMs: GIT_LONG_TIMEOUT_MS,
  });
  const { size } = await fs.stat(file);
  return { packId, chunks: Math.ceil(size / QUEUE_PACK_CHUNK_BYTES) };
}

/** Delete this job's earlier packs (and any other job's pack nobody has fetched for a day). */
export async function deleteOlderPacks(env: QueueJobEnv, jobId: string): Promise<void> {
  let names: string[];
  try { names = await fs.readdir(env.paths.packsDir); } catch { return; }
  const prefix = `${packPrefix(jobId)}-`;
  for (const name of names) {
    const stale = await fs.stat(path.join(env.paths.packsDir, name)).then(stat => env.now() - stat.mtimeMs > 24 * 60 * 60_000, () => false);
    if (name.startsWith(prefix) || stale) await fs.rm(path.join(env.paths.packsDir, name), { force: true });
  }
}

/** One chunk of a kept pack, for `queue.fetchPack`. */
export async function fetchPackChunk(env: QueueJobEnv, params: QueueFetchPackParams): Promise<QueueFetchPackResult> {
  const file = env.paths.packFile(params.packId);
  const handle = await fs.open(file, 'r').catch(() => null);
  if (!handle) throw new Error('That pack is not kept on this computer (a newer collect replaced it, or the job was removed).');
  try {
    const { size } = await handle.stat();
    const offset = params.index * QUEUE_PACK_CHUNK_BYTES;
    if (offset >= size) throw new Error('That chunk is past the end of the pack.');
    const buffer = Buffer.alloc(Math.min(QUEUE_PACK_CHUNK_BYTES, size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return { dataBase64: buffer.subarray(0, bytesRead).toString('base64') };
  } finally {
    await handle.close();
  }
}
