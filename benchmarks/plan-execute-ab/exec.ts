import { spawn } from 'child_process';
import type { CommandResult } from './types';

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  /** Called for each stdout chunk (for live log capture). */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

const KILL_GRACE_MS = 5_000;

export async function runCommand(command: string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  const [cmd, ...args] = command;
  if (!cmd) {
    throw new Error('runCommand: empty command');
  }
  const startedAt = Date.now();
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const timeoutMs = options.timeoutMs ?? 0;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
        }, timeoutMs)
      : undefined;

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      options.onStderr?.(text);
    });

    child.stdin?.on('error', () => {
      // EPIPE is expected when the child exits before consuming stdin.
    });
    if (options.stdin !== undefined) {
      child.stdin?.write(options.stdin);
    }
    child.stdin?.end();

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        command,
        exitCode,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    };

    child.on('error', (err) => {
      stderr += `\nspawn error: ${err.message}`;
      finish(null);
    });
    child.on('close', (code) => {
      finish(code);
    });
  });
}

export function parseNdjson<T = Record<string, unknown>>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // Non-JSON chatter is kept in the raw log but ignored for structure.
    }
  }
  return out;
}

export function tail(text: string, maxChars = 4_000): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}
