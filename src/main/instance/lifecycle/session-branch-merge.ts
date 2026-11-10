/**
 * session-branch-merge.ts
 *
 * Merge a finished session's branch back into the repo's default branch (main),
 * then delete the branch. Used by InstanceTerminationCoordinator when a regular
 * session ends cleanly (status 'idle') on a non-default branch.
 *
 * SAFE by construction:
 *   - never throws for "nothing to do" cases (not a repo, detached, already on base,
 *     no new commits, dirty tree) — it returns a reason instead.
 *   - on a merge conflict it aborts the merge, switches back to the session branch,
 *     and returns { merged: false, reason: 'conflict' } without corrupting the base.
 *   - passes AIO_ALLOW_MAIN_UPDATE=1 so the stay-on-main reference-transaction guard
 *     treats this as a deliberate, audited integration.
 *   - never replaces a file Git ignores: the switches and the fast-forward refuse, and
 *     the merge is checked first, returning { merged: false, reason: 'ignored-files' }.
 *
 * The git command sequence here is the TypeScript port of scripts/finish-to-main.sh,
 * which is covered by an isolated 7/7 git-behaviour test. The ignored-file checks
 * are not in the script.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  fastForwardPullCommands,
  ignoredFilesBlockReason,
  mergeResultTree,
  NO_OVERWRITE_IGNORE,
} from '../../workspace/git/ignored-file-guard';
import { IGNORED_FILES_UNCHECKED_REASON } from '../../../shared/copy/ignored-files-copy';

const execFileAsync = promisify(execFile);

export type SessionMergeReason =
  | 'merged'
  | 'not-a-repo'
  | 'detached'
  | 'on-base'
  | 'no-base'
  | 'no-commits'
  | 'dirty'
  | 'ignored-files'
  | 'conflict'
  | 'error';

export interface SessionMergeResult {
  merged: boolean;
  reason: SessionMergeReason;
  branch?: string;
  base?: string;
  detail?: string;
}

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout.trim();
}

async function tryGit(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    return await git(cwd, args, env);
  } catch {
    return null;
  }
}

async function resolveBaseBranch(cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const originHead = await tryGit(
    cwd,
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    env,
  );
  if (originHead) {
    return originHead.replace(/^origin\//, '');
  }
  for (const candidate of ['main', 'master']) {
    if ((await tryGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], env)) !== null) {
      return candidate;
    }
  }
  return null;
}

/**
 * Merge the current branch of `workingDirectory` back into its base branch and
 * delete it. Returns a structured result; callers handle logging.
 */
export async function mergeSessionBranchToMain(workingDirectory: string): Promise<SessionMergeResult> {
  // Deliberate integration: bypass the stay-on-main guard for these writes only.
  const env: NodeJS.ProcessEnv = { ...process.env, AIO_ALLOW_MAIN_UPDATE: '1' };

  if ((await tryGit(workingDirectory, ['rev-parse', '--is-inside-work-tree'], env)) !== 'true') {
    return { merged: false, reason: 'not-a-repo' };
  }
  const root = (await tryGit(workingDirectory, ['rev-parse', '--show-toplevel'], env)) ?? workingDirectory;

  const branch = await tryGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], env);
  if (!branch) {
    return { merged: false, reason: 'detached' };
  }

  const base = await resolveBaseBranch(root, env);
  if (!base) {
    return { merged: false, reason: 'no-base' };
  }
  if (branch === base) {
    return { merged: false, reason: 'on-base', branch, base };
  }

  // Only merge committed work, and only when the tree is clean.
  const ahead = await tryGit(root, ['rev-list', '--count', `${base}..${branch}`], env);
  if (ahead === null || ahead === '0') {
    return { merged: false, reason: 'no-commits', branch, base };
  }
  const dirty = await tryGit(root, ['status', '--porcelain'], env);
  if (dirty && dirty.length > 0) {
    return { merged: false, reason: 'dirty', branch, base };
  }

  if ((await tryGit(root, ['switch', NO_OVERWRITE_IGNORE, base], env)) === null) {
    return { merged: false, reason: 'error', branch, base, detail: 'could not switch to base branch' };
  }
  // Best-effort: bring the base up to date with its upstream, fetched by name; ignore failures
  // (offline / no upstream / an ignored file in the way). Like `git pull --ff-only`, skip it when
  // the base follows several branches, which one fast-forward cannot reach.
  const upstreamRemote = await tryGit(root, ['config', '--get', `branch.${base}.remote`], env);
  const upstreamRefs = (await tryGit(root, ['config', '--get-all', `branch.${base}.merge`], env))?.split('\n') ?? [];
  if (upstreamRemote && upstreamRefs.length === 1 && upstreamRefs[0]) {
    for (const args of fastForwardPullCommands(upstreamRemote, upstreamRefs[0])) {
      if ((await tryGit(root, args, env)) === null) break;
    }
  }

  // A three-way merge replaces ignored files whatever its options, so look before merging.
  let blocked: string | null;
  try {
    blocked = await ignoredFilesBlockReason(root, await mergeResultTree(root, branch));
  } catch (error) {
    // Only working out the merge throws; the check itself blocks with a reason instead.
    await tryGit(root, ['switch', NO_OVERWRITE_IGNORE, branch], env);
    const message = error instanceof Error ? error.message : String(error);
    return { merged: false, reason: 'error', branch, base, detail: `could not work out what the merge would change: ${message}` };
  }
  if (blocked) {
    await tryGit(root, ['switch', NO_OVERWRITE_IGNORE, branch], env);
    const reason = blocked === IGNORED_FILES_UNCHECKED_REASON ? 'error' : 'ignored-files';
    return { merged: false, reason, branch, base, detail: blocked };
  }

  try {
    await git(root, ['merge', '--no-ff', '-m', `Merge ${branch} into ${base}`, branch], env);
  } catch {
    await tryGit(root, ['merge', '--abort'], env);
    await tryGit(root, ['switch', NO_OVERWRITE_IGNORE, branch], env);
    return { merged: false, reason: 'conflict', branch, base };
  }

  await tryGit(root, ['branch', '-d', branch], env);
  return { merged: true, reason: 'merged', branch, base };
}
