import { execFile } from 'child_process';
import { promisify } from 'util';
import { hermeticGitEnv } from './git-env';

const execFileAsync = promisify(execFile);

/** Run a git command safely — array args, no shell interpolation. */
export async function gitExec(args: string[], cwd: string, timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    // Strip inherited GIT_DIR/GIT_INDEX_FILE/etc. (set when running inside a git
    // hook) so the command resolves its repo purely from cwd. Without this,
    // worktree ops run under a commit hook hit `.git/index: Not a directory`.
    env: hermeticGitEnv(),
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return typeof stdout === 'string' ? stdout.trim() : String(stdout).trim();
}

/** Run git and return stdout, empty string on failure. */
export async function gitExecSafe(args: string[], cwd: string): Promise<string> {
  try {
    return await gitExec(args, cwd);
  } catch {
    return '';
  }
}
