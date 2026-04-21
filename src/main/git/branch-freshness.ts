import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type BranchFreshnessState =
  | 'fresh'
  | 'stale'
  | 'diverged'
  | 'no_upstream'
  | 'not_repo';

export interface BranchFreshnessReport {
  state: BranchFreshnessState;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  summary: string;
}

export class BranchFreshness {
  async inspect(workingDirectory: string): Promise<BranchFreshnessReport> {
    const inRepo = await this.isGitRepo(workingDirectory);
    if (!inRepo) {
      return {
        state: 'not_repo',
        branch: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        summary: 'Working directory is not a git repository.',
      };
    }

    const branch = await this.readGit(workingDirectory, ['branch', '--show-current']);
    const upstream = await this.tryReadGit(workingDirectory, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (!upstream) {
      return {
        state: 'no_upstream',
        branch: branch || null,
        upstream: null,
        ahead: 0,
        behind: 0,
        summary: `Branch ${branch || 'HEAD'} has no upstream configured.`,
      };
    }

    const counts = await this.readGit(workingDirectory, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]);
    const [behindRaw, aheadRaw] = counts.split('\t');
    const behind = Number.parseInt(behindRaw || '0', 10) || 0;
    const ahead = Number.parseInt(aheadRaw || '0', 10) || 0;

    if (ahead > 0 && behind > 0) {
      return {
        state: 'diverged',
        branch: branch || null,
        upstream,
        ahead,
        behind,
        summary: `Branch ${branch || 'HEAD'} has diverged from ${upstream} (${ahead} ahead, ${behind} behind).`,
      };
    }

    if (behind > 0) {
      return {
        state: 'stale',
        branch: branch || null,
        upstream,
        ahead,
        behind,
        summary: `Branch ${branch || 'HEAD'} is behind ${upstream} by ${behind} commit(s).`,
      };
    }

    return {
      state: 'fresh',
      branch: branch || null,
      upstream,
      ahead,
      behind,
      summary: `Branch ${branch || 'HEAD'} is in sync with ${upstream}.`,
    };
  }

  private async isGitRepo(workingDirectory: string): Promise<boolean> {
    try {
      const result = await this.readGit(workingDirectory, ['rev-parse', '--is-inside-work-tree']);
      return result === 'true';
    } catch {
      return false;
    }
  }

  private async tryReadGit(workingDirectory: string, args: string[]): Promise<string | null> {
    try {
      return await this.readGit(workingDirectory, args);
    } catch {
      return null;
    }
  }

  private async readGit(workingDirectory: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: workingDirectory });
    return stdout.trim();
  }
}
