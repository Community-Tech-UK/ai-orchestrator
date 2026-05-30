/**
 * Command template dynamic interpolation (backlog #22).
 *
 * Extends the markdown slash-command system with the two dynamic placeholders
 * the reference tools (opencode, Claude Code) support, beyond the static
 * `$1`/`$ARGUMENTS` substitution in `resolveTemplate`:
 *
 *   - !`shell command`  → replaced with the command's stdout (run in `cwd`)
 *   - @{relative/path}   → replaced with the file's contents (read from `cwd`)
 *
 * SECURITY ORDERING: this runs on the RAW author template, BEFORE user/agent
 * argument substitution. That means a `$1` argument can never be injected into
 * a `!`...`` shell block — only the command author (who controls the template)
 * decides what shell runs. Commands are local, user-authored markdown files, so
 * author-controlled shell execution is the intended capability, not an
 * escalation. Output is size- and time-bounded.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getLogger } from '../logging/logger';

const execAsync = promisify(exec);
const logger = getLogger('CommandInterpolation');

/** `!`cmd`` — shell injection. Non-greedy, single line of backticks. */
const SHELL_PATTERN = /!`([^`]+)`/g;
/** `@{path}` — explicit file inline (braced to avoid matching `@handle` text). */
const FILE_PATTERN = /@\{([^}]+)\}/g;

const MAX_SHELL_OUTPUT = 16_000;
const MAX_FILE_BYTES = 64_000;
const SHELL_TIMEOUT_MS = 15_000;

export interface InterpolationContext {
  /** Directory shell commands run in and relative file paths resolve against. */
  cwd?: string;
}

/**
 * Resolve `!`shell`` and `@{file}` placeholders in a command template. Returns
 * the input unchanged (no I/O) when neither token is present — the common case.
 */
export async function interpolateCommandTemplate(
  template: string,
  ctx: InterpolationContext = {},
): Promise<string> {
  if (!template.includes('!`') && !template.includes('@{')) {
    return template;
  }
  const cwd = ctx.cwd || process.cwd();

  let result = await replaceAsync(template, SHELL_PATTERN, (cmd) => runShell(cmd.trim(), cwd));
  result = await replaceAsync(result, FILE_PATTERN, async (rawPath) => {
    const content = await readFileSafe(rawPath.trim(), cwd);
    return content ?? `@{${rawPath}}`;
  });
  return result;
}

/** Run each regex match's replacer concurrently, then splice results back. */
async function replaceAsync(
  input: string,
  pattern: RegExp,
  replacer: (group: string) => Promise<string>,
): Promise<string> {
  const re = new RegExp(pattern.source, pattern.flags);
  const spans: { start: number; end: number; task: Promise<string> }[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length, task: replacer(match[1]) });
    if (match.index === re.lastIndex) re.lastIndex++; // guard against zero-width
  }
  if (spans.length === 0) return input;

  const results = await Promise.all(spans.map((s) => s.task));
  let out = input;
  // Splice from the end so earlier indices stay valid.
  for (let i = spans.length - 1; i >= 0; i--) {
    out = out.slice(0, spans[i].start) + results[i] + out.slice(spans[i].end);
  }
  return out;
}

async function runShell(cmd: string, cwd: string): Promise<string> {
  if (!cmd) return '';
  try {
    const { stdout } = await execAsync(cmd, {
      cwd,
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: MAX_SHELL_OUTPUT * 4,
      windowsHide: true,
    });
    return truncate(stdout.trimEnd(), MAX_SHELL_OUTPUT);
  } catch (err) {
    const e = err as { stdout?: string; message?: string };
    logger.warn('Shell interpolation failed', { cmd, error: e.message });
    const partial = (e.stdout ?? '').trimEnd();
    return partial ? truncate(partial, MAX_SHELL_OUTPUT) : `[shell error: ${e.message ?? 'failed'}]`;
  }
}

async function readFileSafe(relOrAbs: string, cwd: string): Promise<string | null> {
  try {
    const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.resolve(cwd, relOrAbs);
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return null;
    const buf = await fs.readFile(abs);
    const text = buf.subarray(0, MAX_FILE_BYTES).toString('utf8');
    return buf.length > MAX_FILE_BYTES ? `${text}\n…(truncated)` : text;
  } catch {
    return null;
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n…(truncated)`;
}
