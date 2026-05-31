/**
 * Config / instruction interpolation (backlog #21).
 *
 * Resolves two opencode-style placeholders inside config values and instruction
 * content (CLAUDE.md / AGENTS.md), so machine-local paths and non-secret env can
 * stay OUT of committed files and be substituted at injection time:
 *
 *   - {env:VAR}            → value of process.env.VAR  ('' if unset)
 *   - {env:VAR:-fallback}  → process.env.VAR, or `fallback` when unset/empty
 *   - {file:path}          → contents of a PROJECT-RELATIVE file (bounded)
 *
 * SECURITY MODEL (instruction content can originate from an UNTRUSTED repo —
 * a cloned project's CLAUDE.md/AGENTS.md is attacker-controlled):
 *   - {file:...} is confined to the project root (`cwd`). Absolute paths, `~`
 *     home paths, and `../` escapes are rejected, and a realpath check defeats
 *     symlinks that point outside the root. This prevents arbitrary file reads
 *     (e.g. {file:/etc/passwd}, {file:~/.ssh/id_rsa}) from a hostile repo.
 *   - {env:...} refuses to resolve secret-shaped variable names by default
 *     (anything matching TOKEN/SECRET/PASSWORD/KEY/CREDENTIAL/AUTH/...), so a
 *     hostile CLAUDE.md cannot exfiltrate ANTHROPIC_API_KEY / AWS_SECRET_* by
 *     inlining it into the prompt. Trusted callers may opt in via allowSecretEnv.
 *   - Resolution is single-pass: resolved env values and file contents are NOT
 *     re-scanned for placeholders (a secret containing "{file:...}" can never
 *     trigger a second read).
 *   - Resolution happens at INJECTION time, never written back to source files.
 *   - The fast path returns the input unchanged with zero I/O when no token is
 *     present (the overwhelmingly common case).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../../logging/logger';

const logger = getLogger('ConfigInterpolation');

/** {env:VAR} or {env:VAR:-default}. VAR is a standard env identifier. */
const ENV_PATTERN = /\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
/** {file:path} — path runs until the closing brace. */
const FILE_PATTERN = /\{file:([^}]+)\}/g;

/** Quick test so the common (no-token) case skips all work. */
const ANY_TOKEN = /\{(?:env|file):/;

/**
 * Env var names that look like secrets and are refused by default to prevent
 * exfiltration of credentials into a prompt via untrusted instruction content.
 */
const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|APIKEY|API_KEY|ACCESS_KEY|AUTH|_KEY$)/i;

const DEFAULT_MAX_FILE_BYTES = 64_000;

export interface ConfigInterpolationContext {
  /** Project root that {file:...} reads are confined to. Defaults to process.cwd(). */
  cwd?: string;
  /** Env source. Defaults to process.env. Injectable for tests. */
  env?: Record<string, string | undefined>;
  /** Max bytes read per {file:...}. Larger files are truncated with a warning. */
  maxFileBytes?: number;
  /** File reader. Injectable for tests. */
  readFile?: (absPath: string, maxBytes: number) => Promise<string>;
  /** realpath resolver for the symlink-escape check. Injectable for tests. */
  realpath?: (p: string) => Promise<string>;
  /** Allow secret-shaped {env:...} names (trusted callers only). Default false. */
  allowSecretEnv?: boolean;
}

export interface ConfigInterpolationResult {
  /** The interpolated string. */
  content: string;
  /** Non-fatal issues (blocked/missing/truncated placeholders). */
  warnings: string[];
  /** True when at least one placeholder was found (and an attempt made to resolve it). */
  interpolated: boolean;
}

async function defaultReadFile(absPath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(absPath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString('utf-8');
  } finally {
    await handle.close();
  }
}

function isContained(child: string, root: string): boolean {
  return child === root || child.startsWith(root + path.sep);
}

/**
 * Resolve a single {file:rawPath}, confined to `root`. Returns the file's content
 * or '' with a warning when blocked/unreadable.
 */
async function resolveFileToken(
  rawPath: string,
  root: string,
  maxFileBytes: number,
  readFile: NonNullable<ConfigInterpolationContext['readFile']>,
  realpath: NonNullable<ConfigInterpolationContext['realpath']>,
): Promise<{ value: string; warning?: string }> {
  if (rawPath.startsWith('~')) {
    return { value: '', warning: `{file:${rawPath}} home-relative paths are not allowed; use a project-relative path` };
  }
  const resolved = path.resolve(root, rawPath);
  // Lexical containment: blocks absolute paths and ../ escapes.
  if (!isContained(resolved, root)) {
    return { value: '', warning: `{file:${rawPath}} resolves outside the project root and was blocked` };
  }
  // Symlink defense-in-depth: if the real path escapes the real root, block.
  // realpath throws when the target does not exist yet — in that case lexical
  // containment already passed and the read below will fail cleanly.
  try {
    const realRoot = await realpath(root);
    const realResolved = await realpath(resolved);
    if (!isContained(realResolved, realRoot)) {
      return { value: '', warning: `{file:${rawPath}} resolves via symlink outside the project root and was blocked` };
    }
  } catch {
    // target missing / not yet created — fall through to the bounded read
  }
  try {
    let data = await readFile(resolved, maxFileBytes + 1);
    if (data.length > maxFileBytes) {
      data = data.slice(0, maxFileBytes);
      return { value: data, warning: `{file:${rawPath}} exceeded ${maxFileBytes} bytes and was truncated` };
    }
    return { value: data };
  } catch (error) {
    return {
      value: '',
      warning: `{file:${rawPath}} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Resolve {env:...} and {file:...} placeholders in `input`. Returns the input
 * unchanged (no I/O) when neither token is present.
 */
export async function interpolateConfigString(
  input: string,
  ctx: ConfigInterpolationContext = {},
): Promise<ConfigInterpolationResult> {
  if (!input || !ANY_TOKEN.test(input)) {
    return { content: input, warnings: [], interpolated: false };
  }

  const env = ctx.env ?? process.env;
  const root = path.resolve(ctx.cwd ?? process.cwd());
  const maxFileBytes = ctx.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const readFile = ctx.readFile ?? defaultReadFile;
  const realpath = ctx.realpath ?? fs.realpath;
  const allowSecretEnv = ctx.allowSecretEnv ?? false;
  const warnings: string[] = [];

  // 1) env — synchronous.
  let content = input.replace(ENV_PATTERN, (_match, name: string, fallback?: string) => {
    if (!allowSecretEnv && SECRET_ENV_NAME.test(name)) {
      warnings.push(`{env:${name}} looks like a secret and was blocked; resolved to empty`);
      return '';
    }
    const value = env[name];
    if (value !== undefined && value !== '') return value;
    if (fallback !== undefined) return fallback;
    warnings.push(`{env:${name}} is unset and has no default; resolved to empty`);
    return '';
  });

  // 2) file — async; resolve each match (confined to root), then splice in order.
  const fileMatches = [...content.matchAll(FILE_PATTERN)];
  if (fileMatches.length > 0) {
    const replacements = await Promise.all(
      fileMatches.map((m) => resolveFileToken(m[1].trim(), root, maxFileBytes, readFile, realpath)),
    );
    let cursor = 0;
    let out = '';
    for (let i = 0; i < fileMatches.length; i++) {
      const m = fileMatches[i];
      const index = m.index ?? 0;
      out += content.slice(cursor, index) + replacements[i].value;
      cursor = index + m[0].length;
      if (replacements[i].warning) warnings.push(replacements[i].warning as string);
    }
    out += content.slice(cursor);
    content = out;
  }

  if (warnings.length > 0) {
    logger.debug('Config interpolation produced warnings', { count: warnings.length });
  }

  return { content, warnings, interpolated: true };
}
