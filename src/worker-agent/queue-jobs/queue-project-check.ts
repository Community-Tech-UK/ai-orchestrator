import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getLogger } from '../../main/logging/logger';
import type { QueueProjectCheckParams, QueueProjectCheckResult } from '../../main/remote-node/queue-job-rpc-schemas';
import { git, GIT_LONG_TIMEOUT_MS } from './queue-git';
import type { QueueJobEnv } from './queue-job-env';
import { provisionJobFolderDependencies } from './queue-job-dependencies';
import { removeWorktreeFolder } from './queue-job-cleanup';
import type { InstalledCheckoutResult, QueueInstalledCheckout } from './queue-installed-checkout';
import { queueRefName, type QueueRepoStore } from './queue-repo-store';

const logger = getLogger('QueueProjectCheck');
type Step = QueueProjectCheckResult['steps'][number];

export interface QueueProjectCheckContext {
  env: QueueJobEnv;
  repos: QueueRepoStore;
  installed: QueueInstalledCheckout;
}

/**
 * Can this project be built and checked on this computer? Uses the commit already received under `jobId`: makes
 * the installed checkout, runs the named `npm run <script>` steps in it with time limits, times how long a fresh
 * job folder's dependency setup takes, and removes that scratch folder. Failures come back as plain words.
 */
export function checkProject(context: QueueProjectCheckContext, params: QueueProjectCheckParams): Promise<QueueProjectCheckResult> {
  return context.env.mutex.run(`job:${params.jobId}`, () => checkLocked(context, params));
}

async function checkLocked({ env, repos, installed }: QueueProjectCheckContext, params: QueueProjectCheckParams): Promise<QueueProjectCheckResult> {
  const steps: Step[] = [];
  const fail = (problem: string): QueueProjectCheckResult => ({ ok: false, steps, copyMs: null, problem: problem.slice(0, 2000) });
  const commit = await repos.refValue(params.project, queueRefName(params.jobId, 'start'))
    ?? await repos.refValue(params.project, queueRefName(params.jobId, 'sent'));
  if (!commit) return fail('This computer has not been sent the project\'s code yet, so nothing could be checked.');

  const installStarted = env.now();
  let checkoutReady = false;
  try {
    return await installed.use(params.project, commit, checkout => {
      checkoutReady = true;
      return runChecks({ env, repos }, params, commit, checkout, steps, fail);
    });
  } catch (error) {
    if (checkoutReady) throw error; // not the install: let it surface as an error rather than as a wrong plain reason
    const message = error instanceof Error ? error.message : String(error);
    steps.push({ name: 'install dependencies', ms: env.now() - installStarted, ok: false, tail: message.slice(-4000) });
    return fail(`Installing the project's dependencies on this computer failed. ${message.slice(0, 600)}`);
  }
}

/** Runs while the installed checkout is held, so nothing reinstalls it under the steps. */
async function runChecks(
  { env, repos }: Pick<QueueProjectCheckContext, 'env' | 'repos'>,
  params: QueueProjectCheckParams,
  commit: string,
  checkout: InstalledCheckoutResult,
  steps: Step[],
  fail: (problem: string) => QueueProjectCheckResult,
): Promise<QueueProjectCheckResult> {
  if (checkout.installed) steps.push({ name: 'install dependencies', ms: checkout.installMs, ok: true, tail: '' });

  for (const script of params.scripts) {
    const name = `npm run ${script}`;
    const started = env.now();
    const result = await env.runner('npm', ['run', script], { cwd: checkout.path, timeoutMs: env.limits.stepTimeoutMs });
    const ok = result.code === 0 && !result.timedOut;
    steps.push({ name, ms: env.now() - started, ok, tail: result.tail.slice(-4000) });
    if (!ok) {
      return fail(result.timedOut
        ? `The step "${name}" did not finish within ${Math.round(env.limits.stepTimeoutMs / 60_000)} minutes on this computer, so it was stopped.`
        : `The step "${name}" failed on this computer (exit code ${result.code ?? 'none'}). Its last output is in the step's details.`);
    }
  }

  const bare = env.paths.bareRepo(params.project);
  const scratch = path.join(env.paths.worktreesDir, 'queue', `projectcheck-${params.jobId}`);
  const repoExists = await repos.exists(params.project);
  try {
    await removeWorktreeFolder(bare, scratch, repoExists); // one a crashed check left behind
    await fs.mkdir(path.dirname(scratch), { recursive: true });
    await git(['worktree', 'add', '--detach', scratch, commit], bare, { timeoutMs: GIT_LONG_TIMEOUT_MS });
    const copyStarted = env.now();
    await provisionJobFolderDependencies(checkout.path, scratch);
    const copyMs = env.now() - copyStarted;
    const hasDependencies = await fs.readdir(path.join(scratch, 'node_modules')).then(entries => entries.length > 0, () => false);
    if (!hasDependencies && await fs.stat(path.join(checkout.path, 'node_modules')).then(() => true, () => false)) {
      return fail('A fresh job folder could not be given the project\'s dependencies on this computer (linking or copying them failed).');
    }
    return { ok: true, steps, copyMs, problem: null };
  } catch (error) {
    logger.warn('A queue project check could not make its scratch folder', { message: error instanceof Error ? error.message : String(error) });
    return fail(`Making a fresh job folder on this computer failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 600)}`);
  } finally {
    await removeWorktreeFolder(bare, scratch, repoExists).catch(() => undefined);
  }
}
