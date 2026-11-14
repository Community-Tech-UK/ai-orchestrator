/**
 * Git for the remote-job code: an explicit argument list (no shell), the same hermetic environment the rest of the
 * main process uses, and stdout either collected or written straight to a file (a first pack can be large).
 */
import { spawn } from 'node:child_process';
import type { FileHandle } from 'node:fs/promises';
import { hermeticGitEnv } from '../../workspace/git/git-env';

const DEFAULT_TIMEOUT_MS = 2 * 60_000;
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_CHARS = 4_000;

export class QueueJobGitError extends Error {
  constructor(readonly args: readonly string[], readonly code: number | null, readonly stderr: string) {
    super(`git ${args[0] ?? ''} failed${code === null ? '' : ` (exit ${code})`}: ${stderr.trim().slice(0, 500)}`);
    this.name = 'QueueJobGitError';
  }
}

export interface QueueJobGitOptions {
  /** Written to git's stdin, then closed. */
  input?: string | Buffer;
  /** Streamed into git's stdin instead of `input`. */
  stdinFrom?: NodeJS.ReadableStream;
  /** Write stdout to this open file instead of collecting it (the result is then empty). */
  stdoutTo?: FileHandle;
  timeoutMs?: number;
  /** Extra environment for this call. */
  env?: NodeJS.ProcessEnv;
}

/** Run git and return its stdout. Throws `QueueJobGitError` on a non-zero exit. */
export function runGit(args: readonly string[], cwd: string, options: QueueJobGitOptions = {}): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd,
      env: { ...hermeticGitEnv(process.env, cwd), ...options.env },
      stdio: ['pipe', options.stdoutTo ? options.stdoutTo.fd : 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let stderr = '';
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new QueueJobGitError(args, null, `timed out after ${(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000} s`)));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const stdin = child.stdin;
    if (!stdin) { child.kill('SIGKILL'); finish(() => reject(new Error('git has no input stream'))); return; }
    child.stdout?.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_STDOUT_BYTES) {
        child.kill('SIGKILL');
        finish(() => reject(new QueueJobGitError(args, null, 'produced more output than expected')));
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_CHARS); });
    child.on('error', error => finish(() => reject(error)));
    // git may exit before reading its input (EPIPE); its exit code reports why.
    stdin.on('error', () => undefined);
    child.on('close', code => finish(() => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new QueueJobGitError(args, code, stderr));
    }));
    if (options.stdinFrom) {
      options.stdinFrom.on('error', error => { child.kill('SIGKILL'); finish(() => reject(error)); });
      options.stdinFrom.pipe(stdin);
    } else {
      stdin.end(options.input);
    }
  });
}

/** Run git and return trimmed text. */
export async function gitText(args: readonly string[], cwd: string, options?: QueueJobGitOptions): Promise<string> {
  return (await runGit(args, cwd, options)).toString('utf8').trim();
}

/** True when `commit` is a commit in the repository's object store. */
export async function hasCommit(repo: string, commit: string): Promise<boolean> {
  try { await runGit(['cat-file', '-e', `${commit}^{commit}`], repo); return true; }
  catch (error) { if (error instanceof QueueJobGitError) return false; throw error; }
}
