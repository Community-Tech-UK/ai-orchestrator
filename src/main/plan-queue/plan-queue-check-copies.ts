/** Disposable check copies, with ownership durable before Git creates them. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { z } from 'zod';
import { getLogger } from '../logging/logger';
import { gitExec } from '../workspace/git/git-exec';
import { getGitWriteQueue } from '../workspace/git/git-write-queue';
import { provisionWorktreeDependencies } from '../workspace/git/worktree-deps';
import { deleteLocalBranchIfPresent, pathCompareKey, removeManagedWorktreeDirectory,
  verifyManagedWorktreeOwnership } from '../workspace/git/worktree-cleanup';
import { unresolvedMergeFiles } from './plan-queue-git';
import type { PlanQueueWorktreeCreator } from './plan-queue-worktree';

const logger = getLogger('PlanQueueCheckCopies');
const RECORD_DIRECTORY = 'plan-queue-check-copies';
const OwnershipSchema = z.object({
  id: z.uuid(), kind: z.enum(['base', 'combined']), ownerPid: z.number().int().positive(), ownerHost: z.string().min(1),
  repoRoot: z.string().min(1), worktreePath: z.string().min(1), baseDir: z.string().min(1),
  branchName: z.string().min(1), baseTip: z.string().regex(/^[a-f0-9]{40,64}$/),
  cleanupTip: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
}).strict();
type Ownership = z.infer<typeof OwnershipSchema>;

export interface PlanQueueCheckMember { itemId: string; head: string }
export interface PlanQueueCombinedCopy {
  cwd: string;
  head: string;
  testedTree: string;
  members: PlanQueueCheckMember[];
}
interface CopyOptions {
  repoRoot: string;
  baseTip: string;
  kind: Ownership['kind'];
  creator: PlanQueueWorktreeCreator;
  skipInstall?: boolean;
  signal?: AbortSignal;
}

/** Named branches match the manager's creation and exact-branch cleanup contract. */
export async function withPlanQueueCheckCopy<T>(options: CopyOptions, action: (cwd: string) => Promise<T>): Promise<T> {
  const { repoRoot, baseTip, kind, creator, signal } = options;
  signal?.throwIfAborted();
  const id = randomUUID();
  let ownershipFile: string | undefined;
  let ownership: Ownership | undefined;
  const session = await creator.createWorktree(`plan-queue-${kind}`, `${kind} gate checks`, {
    repoRoot, baseBranch: baseTip, branchName: `${kind}-gate-checks-${id}`, skipInstall: true, countsTowardLimit: false,
    onPrepared: async prepared => {
      const root = await fs.realpath(repoRoot);
      const baseDir = path.relative(root, path.dirname(prepared.worktreePath));
      ownership = { id, kind, ownerPid: process.pid, ownerHost: hostname(), repoRoot: root,
        worktreePath: prepared.worktreePath, baseDir, branchName: prepared.branchName, baseTip };
      assertRecordIdentity(ownership, root, `${id}.json`);
      const directory = await recordDirectory(root);
      await fs.mkdir(directory, { recursive: true });
      ownershipFile = path.join(directory, `${id}.json`);
      await fs.writeFile(ownershipFile, JSON.stringify(ownership), { flag: 'wx', mode: 0o600 });
    },
  });
  try {
    signal?.throwIfAborted();
    if (await gitExec(['rev-parse', 'HEAD'], session.worktreePath) !== baseTip
      || await gitExec(['status', '--porcelain', '--untracked-files=no'], session.worktreePath)) {
      throw new Error('The check copy is not clean at the requested commit');
    }
    return await action(session.worktreePath);
  } finally {
    // A failed removal keeps the marker so startup can retry using the same proof.
    if (ownership && ownershipFile) await getGitWriteQueue().enqueue('plan-queue-check-copy-cleanup-proof', () =>
      recordCleanupTip(ownership!, ownershipFile!));
    await creator.cleanupWorktree(session.id, { force: true, retainBranch: false, deleteBranch: true });
    if (ownershipFile) await fs.unlink(ownershipFile);
  }
}

export async function provisionPlanQueueCheckCopy(options: Pick<CopyOptions, 'repoRoot' | 'skipInstall' | 'signal'>, cwd: string): Promise<void> {
  options.signal?.throwIfAborted();
  const head = await gitExec(['rev-parse', 'HEAD'], cwd);
  if (!options.skipInstall) {
    let locked = false;
    for (const name of ['package-lock.json', 'npm-shrinkwrap.json']) {
      try { await fs.access(path.join(cwd, name)); locked = true; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await provisionWorktreeDependencies(options.repoRoot, cwd, locked ? { installCommand: 'npm ci' } : undefined);
  }
  options.signal?.throwIfAborted();
  if (await gitExec(['rev-parse', 'HEAD'], cwd) !== head || await gitExec(['status', '--porcelain', '--untracked-files=no'], cwd)) {
    throw new Error('Dependency provisioning changed the check copy');
  }
}

export async function withPlanQueueCombinedCopy<T>(
  options: Omit<CopyOptions, 'kind'>,
  members: readonly PlanQueueCheckMember[],
  action: (copy: PlanQueueCombinedCopy) => Promise<T>,
): Promise<T | undefined> {
  const { repoRoot, baseTip, signal } = options;
  signal?.throwIfAborted();
  if (members.length < 2) return undefined;
  const eligible: PlanQueueCheckMember[] = [];
  for (const member of members) {
    signal?.throwIfAborted();
    try {
      await getGitWriteQueue().enqueue('plan-queue-combined-preflight', () =>
        gitExec(['merge-tree', '--write-tree', baseTip, member.head], repoRoot));
      eligible.push(member);
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: unknown };
      if (failure.code !== 1 || typeof failure.stdout !== 'string'
        || !/^[a-f0-9]{40,64}\r?\n/.test(failure.stdout) || !failure.stdout.includes('CONFLICT')) throw error;
    }
  }
  if (eligible.length < 2 || eligible[0].itemId !== members[0].itemId) return undefined;
  return withPlanQueueCheckCopy({ ...options, kind: 'combined' }, async cwd => {
    const merged: PlanQueueCheckMember[] = [];
    for (const member of eligible) {
      signal?.throwIfAborted();
      const included = await getGitWriteQueue().enqueue('plan-queue-combined-merge', async () => {
        try {
          await gitExec(['merge', '--no-ff', '--no-verify', '--no-edit', '--no-gpg-sign', member.head], cwd);
          return true;
        } catch (error) {
          const conflicts = await unresolvedMergeFiles(cwd);
          if (!conflicts?.length) throw error;
          await gitExec(['merge', '--abort'], cwd);
          return false;
        }
      });
      if (included) merged.push(member);
    }
    signal?.throwIfAborted();
    if (merged.length < 2 || merged[0].itemId !== members[0].itemId) return undefined;
    await provisionPlanQueueCheckCopy(options, cwd);
    const head = await gitExec(['rev-parse', 'HEAD'], cwd);
    const testedTree = await gitExec(['rev-parse', 'HEAD^{tree}'], cwd);
    return action({ cwd, head, testedTree, members: merged });
  });
}

/** Startup only reaps same-host copies whose owning process is proven gone. */
export async function cleanupPlanQueueCheckCopies(workspaces: readonly string[]): Promise<void> {
  const seen = new Set<string>();
  for (const workspace of workspaces) {
    try { await fs.stat(workspace); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const root = await gitExec(['rev-parse', '--show-toplevel'], workspace);
    const directory = await recordDirectory(root);
    if (seen.has(pathCompareKey(directory))) continue;
    seen.add(pathCompareKey(directory));
    let files: string[];
    try { files = await fs.readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const file of files) {
      const recordPath = path.join(directory, file);
      const stat = await fs.lstat(recordPath);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      let ownership: Ownership;
      try {
        ownership = OwnershipSchema.parse(JSON.parse(await fs.readFile(recordPath, 'utf8')));
        assertRecordIdentity(ownership, await fs.realpath(ownership.repoRoot), file);
        if (pathCompareKey(await recordDirectory(ownership.repoRoot)) !== pathCompareKey(directory)) {
          throw new InvalidCheckCopyIdentity('The check copy belongs to a different Git repository');
        }
      } catch (error) {
        if (!(error instanceof z.ZodError || error instanceof SyntaxError || error instanceof InvalidCheckCopyIdentity
          || (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
        logger.warn('Kept an unrecognised check-copy ownership record', { file, error: String(error) });
        continue;
      }
      if (ownership.ownerHost !== hostname() || !ownerIsGone(ownership.ownerPid)) continue;
      await getGitWriteQueue().enqueue('plan-queue-check-copy-recovery', async () => {
        const proof = { repoRoot: ownership.repoRoot, worktreePath: ownership.worktreePath,
          baseDir: ownership.baseDir, expectedBranch: ownership.branchName };
        if (!await verifyManagedWorktreeOwnership(proof)) {
          if (await finishRemovedCopy(ownership, recordPath)) return;
          logger.warn('Kept a check copy whose Git ownership no longer matches', { file });
          return;
        }
        const tip = await recordCleanupTip(ownership, recordPath);
        await removeManagedWorktreeDirectory({ ...proof, alreadyQueued: true });
        await deleteLocalBranchIfPresent(ownership.repoRoot, ownership.branchName, { allowUnmerged: true, expectedTip: tip }, true);
        await fs.unlink(recordPath);
      });
    }
  }
}

class InvalidCheckCopyIdentity extends Error {}

function assertRecordIdentity(record: Ownership, root: string, filename: string): void {
  const expectedBranch = `${record.kind}-gate-checks-${record.id}`;
  if (filename !== `${record.id}.json` || record.branchName !== expectedBranch
    || pathCompareKey(record.repoRoot) !== pathCompareKey(root)
    || path.isAbsolute(record.baseDir) || !record.baseDir || record.baseDir === '.'
    || record.baseDir === '..' || record.baseDir.startsWith(`..${path.sep}`)
    || pathCompareKey(record.worktreePath) !== pathCompareKey(path.join(root, record.baseDir, expectedBranch))) {
    throw new InvalidCheckCopyIdentity('The check-copy path, branch or repository does not match its ownership record');
  }
}

function ownerIsGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
}

async function recordDirectory(repoRoot: string): Promise<string> {
  return path.join(path.resolve(repoRoot, await gitExec(['rev-parse', '--git-common-dir'], repoRoot)), RECORD_DIRECTORY);
}

/** Save the exact tip before removal, so an interruption cannot strand its branch. */
async function recordCleanupTip(ownership: Ownership, filename: string): Promise<string> {
  const tip = await gitExec(['rev-parse', `refs/heads/${ownership.branchName}`], ownership.repoRoot);
  const temporary = `${filename}.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, JSON.stringify({ ...ownership, cleanupTip: tip }), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
  return tip;
}

/** A missing directory is insufficient: only the recorded cleanup tip may go. */
async function finishRemovedCopy(ownership: Ownership, filename: string): Promise<boolean> {
  try { await fs.lstat(ownership.worktreePath); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const listed = await gitExec(['worktree', 'list', '--porcelain'], ownership.repoRoot);
  if (listed.split('\n').includes(`branch refs/heads/${ownership.branchName}`)) return false;
  const reference = `refs/heads/${ownership.branchName}`;
  const refs = await gitExec(['for-each-ref', '--format=%(refname) %(objectname)', reference], ownership.repoRoot);
  const tip = refs.split('\n').find(line => line.startsWith(`${reference} `))?.slice(reference.length + 1);
  if (tip) {
    if (!ownership.cleanupTip || tip !== ownership.cleanupTip) return false;
    await deleteLocalBranchIfPresent(ownership.repoRoot, ownership.branchName, { allowUnmerged: true, expectedTip: tip }, true);
  }
  await fs.unlink(filename);
  return true;
}
