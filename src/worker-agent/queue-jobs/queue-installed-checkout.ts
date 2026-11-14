import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getLogger } from '../../main/logging/logger';
import { worktreeHasDependencies } from '../../main/workspace/git/worktree-include';
import { git, gitText, gitTry, GIT_LONG_TIMEOUT_MS } from './queue-git';
import type { QueueInstaller, QueueJobEnv } from './queue-job-env';
import { redactTail } from './queue-process';
import type { QueueRepoStore } from './queue-repo-store';

const logger = getLogger('QueueInstalledCheckout');
const LOCK_MARKER = 'queue-installed-lock';
const LOCK_FILE = 'package-lock.json';

export interface InstalledCheckoutResult {
  path: string;
  /** True when this call installed dependencies (the lock file differs from the one last installed). */
  installed: boolean;
  installMs: number;
}

/** `npm ci` (or `npm install` for a project with no lock file) with a time limit; the output is never printed. */
export function npmInstaller(env: Pick<QueueJobEnv, 'runner' | 'limits'>): QueueInstaller {
  return async (installedPath, hasLockFile) => {
    const args = hasLockFile ? ['ci'] : ['install'];
    const result = await env.runner('npm', args, { cwd: installedPath, timeoutMs: env.limits.installTimeoutMs });
    if (result.timedOut) {
      throw new Error(`Installing the project's dependencies took longer than ${Math.round(env.limits.installTimeoutMs / 60_000)} minutes and was stopped.`);
    }
    if (result.code !== 0) {
      throw new Error(`Installing the project's dependencies failed (npm ${args[0]} exit ${result.code ?? 'none'}): ${redactTail(result.tail).slice(-600)}`);
    }
  };
}

/**
 * The project's installed checkout, `<root>/queue-repos/<project>-installed`: a detached worktree of the bare
 * repository, moved to a job's starting commit, with dependencies installed again only when that commit's lock file
 * differs from the one last installed. One installer runs per project at a time (see `use`).
 */
export class QueueInstalledCheckout {
  constructor(private readonly env: QueueJobEnv, private readonly repos: QueueRepoStore) {}

  /**
   * Make the installed checkout current for `startCommit` (installing if its lock file differs), then run `action`
   * while still holding this project's lock, so no other job reinstalls or moves the checkout while `action`
   * links dependencies from it or runs checks in it. Calls for one project therefore take turns.
   */
  use<T>(project: string, startCommit: string, action: (checkout: InstalledCheckoutResult) => Promise<T>): Promise<T> {
    return this.env.mutex.run(`install:${project}`, async () => action(await this.ensureLocked(project, startCommit)));
  }

  private async ensureLocked(project: string, startCommit: string): Promise<InstalledCheckoutResult> {
    const bare = await this.repos.ensureBare(project);
    const installedPath = this.env.paths.installedCheckout(project);
    await this.moveTo(bare, installedPath, startCommit);

    const lockBlob = await gitTry(['rev-parse', '--verify', '--quiet', `${startCommit}:${LOCK_FILE}`], bare);
    const hasPackage = await gitTry(['rev-parse', '--verify', '--quiet', `${startCommit}:package.json`], bare) !== null;
    const lockKey = lockBlob ?? 'none';
    const marker = path.join(await gitText(['rev-parse', '--absolute-git-dir'], installedPath), LOCK_MARKER);
    const lastKey = await fs.readFile(marker, 'utf8').then(text => text.trim(), () => null);
    if (!hasPackage || (lastKey === lockKey && await worktreeHasDependencies(installedPath))) {
      return { path: installedPath, installed: false, installMs: 0 };
    }

    const started = this.env.now();
    await fs.rm(marker, { force: true }); // a failed install must not look finished
    logger.info('Installing a queue project\'s dependencies', { project, lockFile: lockBlob !== null });
    await this.env.install(installedPath, lockBlob !== null);
    await fs.writeFile(marker, lockKey, 'utf8');
    return { path: installedPath, installed: true, installMs: this.env.now() - started };
  }

  /** Make the installed checkout exist and sit at `commit`. */
  private async moveTo(bare: string, installedPath: string, commit: string): Promise<void> {
    const linked = await fs.stat(path.join(installedPath, '.git')).then(stat => stat.isFile(), () => false);
    if (!linked) {
      await git(['worktree', 'prune'], bare);
      await fs.rm(installedPath, { recursive: true, force: true }); // only ever this worker's own folder
      await git(['worktree', 'add', '--detach', installedPath, commit], bare, { timeoutMs: GIT_LONG_TIMEOUT_MS });
      return;
    }
    if (await gitText(['rev-parse', 'HEAD'], installedPath) !== commit) {
      await git(['checkout', '--force', '--detach', commit], installedPath, { timeoutMs: GIT_LONG_TIMEOUT_MS });
    }
  }
}
