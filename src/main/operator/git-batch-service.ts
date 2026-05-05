import * as path from 'path';
import type {
  OperatorGitBatchRepoResult,
  OperatorGitBatchSkipReason,
  OperatorGitBatchSummary,
  OperatorShellCommandEventPayload,
} from '../../shared/types/operator.types';
import { VcsManager, createVcsManager } from '../workspace/git/vcs-manager';

export interface GitBatchPullOptions {
  concurrency?: number;
  ignorePatterns?: string[];
  onShellCommand?: (payload: OperatorShellCommandEventPayload) => void;
}

export class GitBatchService {
  async pullAll(rootPath: string, options: GitBatchPullOptions = {}): Promise<OperatorGitBatchSummary> {
    const normalizedRoot = path.resolve(rootPath);
    const repositories = VcsManager.findRepositories(normalizedRoot, options.ignorePatterns);
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 6, 16));
    const results = await runWithConcurrency(
      repositories,
      concurrency,
      (repositoryPath) => this.pullRepository(repositoryPath, options),
    );

    return {
      rootPath: normalizedRoot,
      total: results.length,
      pulled: results.filter((result) => result.status === 'pulled').length,
      upToDate: results.filter((result) => result.status === 'up_to_date').length,
      skipped: results.filter((result) => result.status === 'skipped').length,
      failed: results.filter((result) => result.status === 'failed').length,
      results: results.sort((a, b) => a.repositoryPath.localeCompare(b.repositoryPath)),
    };
  }

  private async pullRepository(
    repositoryPath: string,
    options: GitBatchPullOptions,
  ): Promise<OperatorGitBatchRepoResult> {
    const startedAt = Date.now();
    const vcs = createVcsManager(repositoryPath, {
      onCommand: options.onShellCommand
        ? (event) => options.onShellCommand?.({
          cmd: event.cmd,
          args: event.args,
          cwd: event.cwd,
          exitCode: event.exitCode,
          durationMs: event.durationMs,
          stdoutBytes: event.stdoutBytes,
          stderrBytes: event.stderrBytes,
          ...(event.error ? { error: event.error } : {}),
        })
        : undefined,
    });
    let branch = vcs.getCurrentBranch();
    let upstream = vcs.getUpstreamBranch();
    let status = vcs.getStatus();

    try {
      const remotes = vcs.getRemotes().filter((remote) => remote.type === 'fetch');
      if (remotes.length === 0) {
        return skipped(repositoryPath, 'no_remote', branch, upstream, status, startedAt);
      }
      if (!branch || branch === 'HEAD') {
        return skipped(repositoryPath, 'detached_head', branch, upstream, status, startedAt);
      }
      if (!upstream) {
        return skipped(repositoryPath, 'no_upstream', branch, upstream, status, startedAt);
      }

      await vcs.fetch({ prune: true });
      branch = vcs.getCurrentBranch();
      upstream = vcs.getUpstreamBranch();
      status = vcs.getStatus();

      if (!status.isClean) {
        return skipped(repositoryPath, 'dirty_worktree', branch, upstream, status, startedAt);
      }
      if (status.ahead > 0 && status.behind > 0) {
        return skipped(repositoryPath, 'divergent', branch, upstream, status, startedAt);
      }
      if (status.behind === 0) {
        return {
          repositoryPath,
          status: 'up_to_date',
          reason: null,
          branch,
          upstream,
          ahead: status.ahead,
          behind: status.behind,
          dirty: false,
          durationMs: Date.now() - startedAt,
          error: null,
        };
      }

      await vcs.pullFastForward();
      const finalStatus = vcs.getStatus();
      return {
        repositoryPath,
        status: 'pulled',
        reason: null,
        branch: vcs.getCurrentBranch(),
        upstream: vcs.getUpstreamBranch(),
        ahead: finalStatus.ahead,
        behind: finalStatus.behind,
        dirty: !finalStatus.isClean,
        durationMs: Date.now() - startedAt,
        error: null,
      };
    } catch (error) {
      return {
        repositoryPath,
        status: 'failed',
        reason: null,
        branch,
        upstream,
        ahead: status.ahead,
        behind: status.behind,
        dirty: !status.isClean,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function getGitBatchService(): GitBatchService {
  return new GitBatchService();
}

function skipped(
  repositoryPath: string,
  reason: OperatorGitBatchSkipReason,
  branch: string | null,
  upstream: string | null,
  status: { ahead: number; behind: number; isClean: boolean },
  startedAt: number,
): OperatorGitBatchRepoResult {
  return {
    repositoryPath,
    status: 'skipped',
    reason,
    branch,
    upstream,
    ahead: status.ahead,
    behind: status.behind,
    dirty: !status.isClean,
    durationMs: Date.now() - startedAt,
    error: null,
  };
}

async function runWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= values.length) {
      return;
    }
    results[index] = await worker(values[index]);
    await runNext();
  }

  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    () => runNext(),
  );
  await Promise.all(workers);
  return results;
}
