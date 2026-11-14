import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { hermeticGitEnv } from '../../main/workspace/git/git-env';

export interface GitOptions {
  /** Merged over the hermetic environment (for example `GIT_INDEX_FILE`). */
  env?: NodeJS.ProcessEnv;
  /** Written to git's standard input. */
  input?: string | Buffer;
  /** A file streamed to git's standard input. */
  stdinFile?: string;
  /** git's standard output is streamed to this file instead of being returned. */
  stdoutFile?: string;
  timeoutMs?: number;
}

export class QueueGitError extends Error {
  constructor(message: string, readonly code: number | null) {
    super(message);
    this.name = 'QueueGitError';
  }
}

export const GIT_TIMEOUT_MS = 60_000;
export const GIT_LONG_TIMEOUT_MS = 10 * 60_000;
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const STDERR_TAIL_BYTES = 4096;

/** Identity for the commits this worker makes itself (never the agent's). */
export const QUEUE_COMMIT_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'Harness queue',
  GIT_AUTHOR_EMAIL: 'queue@harness.invalid',
  GIT_COMMITTER_NAME: 'Harness queue',
  GIT_COMMITTER_EMAIL: 'queue@harness.invalid',
};

/**
 * Run git with an explicit argv (never a shell) and a hermetic environment, so it resolves its repository from
 * `cwd` alone. Resolves with standard output (empty when it went to `stdoutFile`); rejects on a non-zero exit.
 */
export function git(args: string[], cwd: string, options: GitOptions = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const env = { ...hermeticGitEnv(process.env, cwd), GIT_TERMINAL_PROMPT: '0', ...options.env };
    const child = spawn('git', args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    const fileDone = options.stdoutFile ? streamToFile(child.stdout, options.stdoutFile) : null;

    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs ?? GIT_TIMEOUT_MS);
    const finish = (error: Error | null, value = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };

    if (!options.stdoutFile) {
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_STDOUT_BYTES) { overflowed = true; child.kill('SIGKILL'); return; }
        chunks.push(chunk);
      });
    }
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES); });
    child.stdin.on('error', () => undefined); // git may exit before reading all of its input
    if (options.stdinFile) fs.createReadStream(options.stdinFile).on('error', () => child.kill('SIGKILL')).pipe(child.stdin);
    else child.stdin.end(options.input);

    child.on('error', error => finish(error));
    child.on('close', code => {
      void (async () => {
        let fileError: Error | null = null;
        try { await fileDone; } catch (error) { fileError = error instanceof Error ? error : new Error(String(error)); }
        const verb = args[0] ?? 'git';
        if (timedOut) return finish(new QueueGitError(`git ${verb} took too long and was stopped`, code));
        if (overflowed) return finish(new QueueGitError(`git ${verb} produced too much output`, code));
        if (code !== 0) return finish(new QueueGitError(`git ${verb} failed (exit ${code ?? 'signal'}): ${stderr.trim().slice(-600)}`, code));
        if (fileError) return finish(fileError);
        finish(null, Buffer.concat(chunks).toString('utf8'));
      })();
    });
  });
}

/** `git`, with standard output trimmed. */
export async function gitText(args: string[], cwd: string, options: GitOptions = {}): Promise<string> {
  return (await git(args, cwd, options)).trim();
}

/** `git`, resolving null instead of rejecting when git exits non-zero (a missing ref, a failed check). */
export async function gitTry(args: string[], cwd: string, options: GitOptions = {}): Promise<string | null> {
  try {
    return (await git(args, cwd, options)).trim();
  } catch (error) {
    if (error instanceof QueueGitError && error.code !== null) return null;
    throw error;
  }
}

function streamToFile(source: NodeJS.ReadableStream, file: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const sink = fs.createWriteStream(file);
    sink.on('error', reject);
    sink.on('finish', resolve);
    source.on('error', reject);
    source.pipe(sink);
  });
}
