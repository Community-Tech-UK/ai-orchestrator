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
 *
 * The git command sequence here is the TypeScript port of scripts/finish-to-main.sh,
 * which is covered by an isolated 7/7 git-behaviour test.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type SessionMergeReason =
  | 'merged'
  | 'not-a-repo'
  | 'detached'
  | 'on-base'
  | 'no-base'
  | 'no-commits'
  | 'dirty'
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

  if ((await tryGit(root, ['switch', base], env)) === null) {
    return { merged: false, reason: 'error', branch, base, detail: 'could not switch to base branch' };
  }
  // Best-effort sync with a remote if one exists; ignore failures (offline / no upstream).
  await tryGit(root, ['pull', '--ff-only'], env);

  try {
    await git(root, ['merge', '--no-ff', '-m', `Merge ${branch} into ${base}`, branch], env);
  } catch {
    await tryGit(root, ['merge', '--abort'], env);
    await tryGit(root, ['switch', branch], env);
    return { merged: false, reason: 'conflict', branch, base };
  }

  await tryGit(root, ['branch', '-d', branch], env);
  return { merged: true, reason: 'merged', branch, base };
}
