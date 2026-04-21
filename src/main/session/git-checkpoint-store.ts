import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLogger } from '../logging/logger';
import { getProjectStoragePaths } from '../storage/project-storage-paths';

const logger = getLogger('GitCheckpointStore');
const execFileAsync = promisify(execFile);

export interface GitCheckpointSummary {
  mode: 'git' | 'shadow';
  workingDirectory: string;
  repoRoot: string;
  ref: string;
  commit: string;
  createdAt: number;
}

async function runCommand(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function removeDirectoryContents(dir: string, preservedNames: Set<string>): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (preservedNames.has(entry.name)) {
      continue;
    }
    await fs.rm(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

async function copyDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') {
      continue;
    }
    await fs.cp(
      path.join(sourceDir, entry.name),
      path.join(targetDir, entry.name),
      { recursive: true },
    );
  }
}

export class GitCheckpointStore {
  private readonly storagePaths = getProjectStoragePaths();

  async createCheckpoint(params: {
    checkpointId: string;
    sessionId: string;
    workingDirectory: string;
    description?: string;
  }): Promise<GitCheckpointSummary> {
    const repoRoot = await this.resolveRepoRoot(params.workingDirectory);
    if (repoRoot) {
      return this.createGitRepoCheckpoint(repoRoot, params);
    }

    return this.createShadowRepoCheckpoint(params);
  }

  async restore(summary: GitCheckpointSummary): Promise<void> {
    if (summary.mode === 'git') {
      await runCommand(summary.repoRoot, ['restore', '--source', summary.commit, '--worktree', '--', '.']);
      await runCommand(summary.repoRoot, ['clean', '-fd']);
      return;
    }

    await runCommand(summary.repoRoot, ['checkout', '-f', summary.commit]);
    await fs.mkdir(summary.workingDirectory, { recursive: true });
    await removeDirectoryContents(summary.workingDirectory, new Set<string>(['.git']));
    await copyDirectoryContents(summary.repoRoot, summary.workingDirectory);
  }

  private async resolveRepoRoot(workingDirectory: string): Promise<string | null> {
    try {
      return await runCommand(workingDirectory, ['rev-parse', '--show-toplevel']);
    } catch {
      return null;
    }
  }

  private buildRef(sessionId: string, checkpointId: string): string {
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9._-]/g, '-');
    const safeCheckpointId = checkpointId.replace(/[^a-zA-Z0-9._-]/g, '-');
    return `refs/orchestrator/checkpoints/${safeSessionId}/${safeCheckpointId}`;
  }

  private async createGitRepoCheckpoint(
    repoRoot: string,
    params: {
      checkpointId: string;
      sessionId: string;
      workingDirectory: string;
      description?: string;
    },
  ): Promise<GitCheckpointSummary> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-checkpoint-'));
    const tempIndex = path.join(tempDir, 'index');
    const env = {
      ...process.env,
      GIT_INDEX_FILE: tempIndex,
    };
    const createdAt = Date.now();
    try {
      await runCommand(repoRoot, ['add', '-A', '--', '.'], env);
      const tree = await runCommand(repoRoot, ['write-tree'], env);

      let headCommit: string | null = null;
      try {
        headCommit = await runCommand(repoRoot, ['rev-parse', '--verify', 'HEAD']);
      } catch {
        headCommit = null;
      }

      const commitArgs = ['commit-tree', tree, '-m', params.description ?? `Checkpoint ${params.checkpointId}`];
      if (headCommit) {
        commitArgs.splice(2, 0, '-p', headCommit);
      }
      const commit = await runCommand(repoRoot, commitArgs, env);
      const ref = this.buildRef(params.sessionId, params.checkpointId);
      await runCommand(repoRoot, ['update-ref', ref, commit]);

      return {
        mode: 'git',
        workingDirectory: params.workingDirectory,
        repoRoot,
        ref,
        commit,
        createdAt,
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  private async createShadowRepoCheckpoint(params: {
    checkpointId: string;
    sessionId: string;
    workingDirectory: string;
    description?: string;
  }): Promise<GitCheckpointSummary> {
    const shadowRoot = this.storagePaths.getShadowGitRoot(params.workingDirectory);
    await fs.mkdir(shadowRoot, { recursive: true });
    if (!await pathExists(path.join(shadowRoot, '.git'))) {
      await runCommand(shadowRoot, ['init']);
    }
    await runCommand(shadowRoot, ['config', 'user.name', 'AI Orchestrator']);
    await runCommand(shadowRoot, ['config', 'user.email', 'orchestrator@local.invalid']);

    await removeDirectoryContents(shadowRoot, new Set<string>(['.git']));
    await copyDirectoryContents(params.workingDirectory, shadowRoot);
    await runCommand(shadowRoot, ['add', '-A']);

    let commit: string;
    try {
      await runCommand(shadowRoot, ['commit', '-m', params.description ?? `Checkpoint ${params.checkpointId}`]);
      commit = await runCommand(shadowRoot, ['rev-parse', 'HEAD']);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('nothing to commit')) {
        throw error;
      }
      commit = await runCommand(shadowRoot, ['rev-parse', 'HEAD']);
    }

    const ref = this.buildRef(params.sessionId, params.checkpointId);
    await runCommand(shadowRoot, ['update-ref', ref, commit]);

    return {
      mode: 'shadow',
      workingDirectory: params.workingDirectory,
      repoRoot: shadowRoot,
      ref,
      commit,
      createdAt: Date.now(),
    };
  }
}

let gitCheckpointStore: GitCheckpointStore | null = null;

export function getGitCheckpointStore(): GitCheckpointStore {
  if (!gitCheckpointStore) {
    gitCheckpointStore = new GitCheckpointStore();
  }
  return gitCheckpointStore;
}

export function _resetGitCheckpointStoreForTesting(): void {
  gitCheckpointStore = null;
}
