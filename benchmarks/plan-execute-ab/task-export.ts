import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { runCommand } from './exec';

const GIT_IDENTITY = ['-c', 'user.name=plan-execute-ab', '-c', 'user.email=plan-execute-ab@local'];

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'commit.gpgsign',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.hooksPath',
    GIT_CONFIG_VALUE_1: '.git/no-hooks',
    GIT_CONFIG_KEY_2: 'init.templateDir',
    GIT_CONFIG_VALUE_2: '',
  };
}

export interface ExportOptions {
  repoPath: string;
  commitSha: string;
  workRoot: string;
  workspaceName: string;
}

export interface Workspace {
  dir: string;
  repoPath: string;
  commitSha: string;
}

export async function exportWorkspace(options: ExportOptions): Promise<Workspace> {
  const repoPath = resolve(options.repoPath);
  const dir = join(resolve(options.workRoot), options.workspaceName);
  if (existsSync(dir)) {
    throw new Error(`workspace already exists: ${dir}`);
  }
  mkdirSync(dir, { recursive: true });

  const tarball = join(resolve(options.workRoot), `${options.workspaceName}.tar`);
  try {
    execFileSync('git', ['-C', repoPath, 'archive', '--format=tar', '-o', tarball, options.commitSha], {
      stdio: 'pipe',
    });
    const extract = await runCommand(['tar', '-xf', tarball, '-C', dir]);
    if (extract.exitCode !== 0) {
      throw new Error(`tar extract failed: ${extract.stderr.slice(0, 400)}`);
    }
  } finally {
    rmSync(tarball, { force: true });
  }

  const init = await runCommand(['git', ...GIT_IDENTITY, 'init', '-q'], { cwd: dir, env: gitEnv() });
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.slice(0, 400)}`);
  writeWorkspaceExclude(dir);
  const add = await runCommand(['git', ...GIT_IDENTITY, 'add', '-A'], { cwd: dir, env: gitEnv() });
  if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr.slice(0, 400)}`);
  const commit = await runCommand(
    ['git', ...GIT_IDENTITY, 'commit', '-q', '--no-verify', '-m', 'benchmark baseline'],
    { cwd: dir, env: gitEnv() },
  );
  if (commit.exitCode !== 0) throw new Error(`baseline commit failed: ${commit.stderr.slice(0, 400)}`);

  return { dir, repoPath, commitSha: options.commitSha };
}

/**
 * Workspace-only ignore (`.git/info/exclude`, never in a patch): dependency
 * installs, scratch from test runs, and the frozen plan file must not appear in
 * captured diffs or the blind judges would see unrequested changes.
 */
export function writeWorkspaceExclude(dir: string): void {
  const excludePath = join(dir, '.git', 'info', 'exclude');
  mkdirSync(join(dir, '.git', 'info'), { recursive: true });
  writeFileSync(excludePath, ['node_modules', 'PLAN-agent-output.md', '_scratch', ''].join('\n'));
}

export async function capturePatch(workspace: Workspace): Promise<string> {
  const add = await runCommand(['git', '-C', workspace.dir, 'add', '-A'], { env: gitEnv() });
  if (add.exitCode !== 0) throw new Error(`git add for patch capture failed: ${add.stderr.slice(0, 400)}`);
  const diff = await runCommand(['git', '-C', workspace.dir, 'diff', '--cached'], { env: gitEnv() });
  if (diff.exitCode !== 0) throw new Error(`git diff failed: ${diff.stderr.slice(0, 400)}`);
  return diff.stdout;
}

export function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const match of patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    files.add(match[2] ?? '');
  }
  return [...files].filter(Boolean).sort();
}

export function applyHiddenTests(
  repoPath: string,
  commitSha: string,
  hiddenTests: string[],
  workspaceDir: string,
): void {
  for (const relPath of hiddenTests) {
    const content = execFileSync('git', ['-C', resolve(repoPath), 'show', `${commitSha}:${relPath}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    const target = join(workspaceDir, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

export function writePlanFile(workspaceDir: string, planText: string): string {
  const target = join(workspaceDir, 'PLAN-agent-output.md');
  writeFileSync(target, planText);
  return target;
}

export function readPatchFile(path: string): string {
  return readFileSync(path, 'utf8');
}

export interface CleanupOptions {
  /** Test seam: the actual removal. */
  rmImpl?: (dir: string) => void;
  /** Test seam: synchronous pause between retries (ms). */
  sleepImpl?: (ms: number) => void;
  attempts?: number;
}

function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Remove a throwaway workspace. Node's recursive rm can fail transiently
 * (ENOTEMPTY/EBUSY removal races), which once discarded a fully scored run
 * (LT-707) — so retry briefly; a persistent failure is the caller's to judge.
 */
export function cleanupWorkspace(dir: string, options: CleanupOptions = {}): void {
  const rmImpl = options.rmImpl ?? ((target: string) => rmSync(target, { recursive: true, force: true }));
  const sleep = options.sleepImpl ?? syncSleep;
  const attempts = options.attempts ?? 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmImpl(dir);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === 'ENOTEMPTY' || code === 'EBUSY';
      if (!transient || attempt === attempts - 1) throw error;
      sleep(25);
    }
  }
  throw lastError;
}
