import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface TrustedCommandInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface TrustedCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal?: NodeJS.Signals | null;
}

export interface TrustedConfigResolverOptions {
  readonly cwd: string;
  readonly allowCommand: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: Record<string, string | undefined>;
  readonly allowedCommands?: readonly string[];
  readonly readFile?: (absPath: string, maxBytes: number) => Promise<string>;
  readonly runCommand?: (invocation: TrustedCommandInvocation) => Promise<TrustedCommandResult>;
}

export type TrustedConfigToken =
  | { readonly type: 'literal'; readonly value: string }
  | { readonly type: 'env'; readonly name: string }
  | { readonly type: 'file'; readonly path: string }
  | { readonly type: 'cmd'; readonly command: string };

const TOKEN_PATTERN = /\$\{(env|file|cmd):([^}]*)\}/g;
const TOKEN_START_PATTERN = /\$\{(?:env|file|cmd):/;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16_384;
const DEFAULT_ALLOWED_COMMANDS = ['security', 'op', 'bw', 'pass', 'gopass'] as const;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function stripTrailingLineBreaks(value: string): string {
  return value.replace(/[\r\n]+$/g, '');
}

function boundOutput(value: string, maxBytes: number): string {
  return Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8');
}

function commandLabel(executable: string): string {
  return path.basename(executable);
}

function assertAllowedCommand(executable: string, allowedCommands: readonly string[]): void {
  const label = commandLabel(executable);
  if (!allowedCommands.includes(label)) {
    throw new Error(`Trusted config command "${label}" is not allowlisted`);
  }
}

function splitCommand(command: string): { executable: string; args: string[] } {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const ch of command.trim()) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && quote === null) {
      quote = ch;
      continue;
    }
    if (ch === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(ch) && quote === null) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (escaping) current += '\\';
  if (quote !== null) throw new Error('Trusted config command has an unterminated quote');
  if (current) parts.push(current);
  const [executable, ...args] = parts;
  if (!executable) throw new Error('Trusted config command is empty');
  return { executable, args };
}

async function defaultReadFile(absPath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(absPath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, executable: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Trusted config command "${commandLabel(executable)}" timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function defaultRunCommand(invocation: TrustedCommandInvocation): Promise<TrustedCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const append = (current: string, chunk: Buffer): string =>
      boundOutput(current + chunk.toString('utf8'), invocation.maxOutputBytes);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(
        new Error(
          `Trusted config command "${commandLabel(invocation.executable)}" timed out after ${invocation.timeoutMs}ms`,
        ),
      );
    }, invocation.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Trusted config command "${commandLabel(invocation.executable)}" failed to start: ${error.message}`));
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, signal });
    });
  });
}

export function parseTrustedConfigValue(input: string): readonly TrustedConfigToken[] {
  const tokens: TrustedConfigToken[] = [];
  let cursor = 0;
  for (const match of input.matchAll(TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      tokens.push({ type: 'literal', value: input.slice(cursor, index) });
    }
    const type = match[1] as 'env' | 'file' | 'cmd';
    const value = match[2].trim();
    if (type === 'env') tokens.push({ type: 'env', name: value });
    if (type === 'file') tokens.push({ type: 'file', path: value });
    if (type === 'cmd') tokens.push({ type: 'cmd', command: value });
    cursor = index + match[0].length;
  }
  if (cursor < input.length) {
    tokens.push({ type: 'literal', value: input.slice(cursor) });
  }
  return tokens.length === 0 ? [{ type: 'literal', value: input }] : tokens;
}

async function resolveFileToken(tokenPath: string, options: TrustedConfigResolverOptions): Promise<string> {
  if (!tokenPath) throw new Error('Trusted config file token is empty');
  if (tokenPath.startsWith('~')) {
    throw new Error('Trusted config file token does not expand home-relative paths; use an absolute path');
  }
  const cwd = path.resolve(options.cwd);
  const absPath = path.isAbsolute(tokenPath) ? tokenPath : path.resolve(cwd, tokenPath);
  const readFile = options.readFile ?? defaultReadFile;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return stripTrailingLineBreaks(await readFile(absPath, maxOutputBytes));
}

async function resolveCommandToken(command: string, options: TrustedConfigResolverOptions): Promise<string> {
  if (!options.allowCommand) {
    throw new Error('Trusted config command resolution is disabled for this call site');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const { executable, args } = splitCommand(command);
  assertAllowedCommand(executable, options.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS);
  const runCommand = options.runCommand ?? defaultRunCommand;
  const result = await withTimeout(
    runCommand({ executable, args, cwd: path.resolve(options.cwd), timeoutMs, maxOutputBytes }),
    timeoutMs,
    executable,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Trusted config command "${commandLabel(executable)}" exited with code ${result.exitCode}`);
  }
  return stripTrailingLineBreaks(boundOutput(result.stdout, maxOutputBytes));
}

export async function resolveTrustedConfigValue(
  input: string,
  options: TrustedConfigResolverOptions,
): Promise<string> {
  const tokens = parseTrustedConfigValue(input);
  const env = options.env ?? process.env;
  const resolved: string[] = [];

  for (const token of tokens) {
    if (token.type === 'literal') {
      if (TOKEN_START_PATTERN.test(token.value)) {
        throw new Error('Malformed trusted config token expression');
      }
      resolved.push(token.value);
    }
    if (token.type === 'env') {
      if (!ENV_NAME_PATTERN.test(token.name)) {
        throw new Error(`Trusted config env token has an invalid name: ${token.name}`);
      }
      resolved.push(env[token.name] ?? '');
    }
    if (token.type === 'file') {
      resolved.push(await resolveFileToken(token.path, options));
    }
    if (token.type === 'cmd') {
      resolved.push(await resolveCommandToken(token.command, options));
    }
  }

  return resolved.join('');
}
