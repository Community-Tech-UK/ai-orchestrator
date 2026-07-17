/**
 * Fable WS13 Phase A — macOS Seatbelt hardened run mode (core module).
 *
 * Builds the `sandbox-exec` invocation for a hardened CLI spawn: the static
 * deny-default base policy (resources/sandbox/aio-seatbelt-base.sbpl, adapted
 * from Codex) plus GENERATED `(param "WRITABLE_ROOT_n")` write clauses. The
 * writable paths themselves are always passed as `-D` parameters — never
 * string-interpolated into policy text (injection-safe, codex lesson).
 *
 * Also ports Codex's denial classifier (keyword-first, then quick-reject exit
 * codes) and provides the Doctor-time capability probe ("binary exists ≠
 * feature works" — claw-code lesson).
 *
 * Fail-closed: a missing/unreadable base policy makes `buildSeatbeltCommand`
 * throw, so a hardened spawn fails loudly instead of silently running
 * unsandboxed.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../logging/logger';

const logger = getLogger('Seatbelt');

export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';
const PROBE_TIMEOUT_MS = 5_000;

let cachedBasePolicy: string | null = null;

function resolveBasePolicyPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    if (app?.isPackaged) {
      return path.join(process.resourcesPath, 'sandbox', 'aio-seatbelt-base.sbpl');
    }
  } catch {
    // Non-Electron context (tests) — fall through to the repo path.
  }
  // Dev: dist/main/sandbox → project root/resources.
  return path.resolve(__dirname, '../../../resources/sandbox/aio-seatbelt-base.sbpl');
}

/** Load (and cache) the base policy. Throws when missing — fail closed. */
export function loadBasePolicy(policyPath = resolveBasePolicyPath()): string {
  if (cachedBasePolicy !== null) return cachedBasePolicy;
  const policy = fs.readFileSync(policyPath, 'utf-8');
  if (!policy.includes('(deny default)')) {
    throw new Error(`Seatbelt base policy at ${policyPath} is not deny-by-default`);
  }
  cachedBasePolicy = policy;
  return policy;
}

export function _resetSeatbeltForTesting(): void {
  cachedBasePolicy = null;
}

export function isSeatbeltAvailable(): boolean {
  return process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC_PATH);
}

export interface SeatbeltCommand {
  command: string;
  args: string[];
}

/**
 * Wrap a CLI spawn in `sandbox-exec`. Only fixed `WRITABLE_ROOT_n` param KEYS
 * are generated into policy text; the path VALUES ride `-D` arguments.
 */
export function buildSeatbeltCommand(params: {
  command: string;
  args: readonly string[];
  writableRoots: readonly string[];
  basePolicy?: string;
}): SeatbeltCommand {
  const base = params.basePolicy ?? loadBasePolicy();
  const roots = params.writableRoots
    .map((root) => path.resolve(root))
    .filter((root, index, all) => all.indexOf(root) === index);
  if (roots.length === 0) {
    throw new Error('Hardened mode requires at least one writable root (the workspace)');
  }

  const writeClauses = roots
    .map((_root, index) => `(allow file-write* (subpath (param "WRITABLE_ROOT_${index}")))`)
    .join('\n');
  const policy = `${base}\n; --- generated writable roots (values via -D params) ---\n${writeClauses}\n`;

  const definitionArgs = roots.flatMap((root, index) => ['-D', `WRITABLE_ROOT_${index}=${root}`]);
  return {
    command: SANDBOX_EXEC_PATH,
    args: ['-p', policy, ...definitionArgs, '--', params.command, ...params.args],
  };
}

/**
 * Phase A default writable roots for a hardened CLI spawn: the workspace, the
 * system temp dir, and the CLI state homes our providers persist sessions to.
 * Everything else on disk is read-only for the jailed process. Reviewed per
 * provider by the WS13 livetest; tighten there with evidence, not here.
 */
export function defaultHardenedWritableRoots(workingDirectory: string | undefined): string[] {
  const os = require('node:os') as typeof import('node:os'); // eslint-disable-line @typescript-eslint/no-require-imports
  const home = os.homedir();
  return [
    ...(workingDirectory ? [workingDirectory] : []),
    os.tmpdir(),
    path.join(home, '.claude'),
    path.join(home, '.codex'),
    path.join(home, '.gemini'),
    path.join(home, '.copilot'),
    path.join(home, '.ai-orchestrator'),
    path.join(home, '.cache'),
  ];
}

/**
 * The spawn-time wrap decision, pure for testability. FAIL-CLOSED: a hardened
 * spawn on a system where Seatbelt is unavailable throws instead of silently
 * running unsandboxed (plan guardrail: never auto-retry unsandboxed).
 */
export function resolveHardenedSpawn(params: {
  hardened: boolean;
  command: string;
  args: readonly string[];
  writableRoots: readonly string[];
  available?: boolean;
  basePolicy?: string;
}): SeatbeltCommand {
  if (!params.hardened) {
    return { command: params.command, args: [...params.args] };
  }
  const available = params.available ?? isSeatbeltAvailable();
  if (!available) {
    throw new Error(
      'Hardened mode is enabled for this instance but macOS sandbox-exec is unavailable — refusing to spawn unsandboxed.',
    );
  }
  return buildSeatbeltCommand({
    command: params.command,
    args: params.args,
    writableRoots: params.writableRoots,
    ...(params.basePolicy !== undefined ? { basePolicy: params.basePolicy } : {}),
  });
}

export type SandboxFailureKind = 'sandbox-denial' | 'normal-failure';

/**
 * Codex denial heuristic (denial.rs), keyword-first: stderr/stdout keywords
 * mean a likely sandbox denial; otherwise quick-reject exit codes (2/126/127
 * — argument/permission/not-found shell failures) are NORMAL failures.
 */
export function classifySandboxFailure(output: {
  exitCode: number | null;
  stderr?: string;
  stdout?: string;
}): SandboxFailureKind {
  if (output.exitCode === 0) return 'normal-failure';
  const keywords = [
    'operation not permitted',
    'permission denied',
    'read-only file system',
    'sandbox',
    'deny(1)',
    'failed to write file',
  ];
  const haystack = `${output.stderr ?? ''}\n${output.stdout ?? ''}`.toLowerCase();
  if (keywords.some((needle) => haystack.includes(needle))) {
    return 'sandbox-denial';
  }
  return 'normal-failure';
}

/**
 * WS13 slice 3 — the exit-seam advice decision, pure for testability. Returns
 * the user-facing advice sentence when a HARDENED instance's exit classifies
 * as a sandbox denial, else null. Callers append it to the crash error and
 * raise the allow-and-retry lever.
 */
export function buildSandboxExitAdvice(params: {
  hardened: boolean;
  exitCode: number | null;
  recentOutput: string;
}): string | null {
  if (!params.hardened) return null;
  const kind = classifySandboxFailure({ exitCode: params.exitCode, stderr: params.recentOutput });
  if (kind !== 'sandbox-denial') return null;
  return (
    '. Hardened mode (Seatbelt) likely blocked file access. ' +
    'Use "Allow path & retry" on this session to grant the blocked path, ' +
    'or recreate the session without hardened mode.'
  );
}

export interface SeatbeltProbeResult {
  supported: boolean;
  reason?: string;
}

/**
 * Doctor-time capability probe: actually RUN a no-op under sandbox-exec.
 * Binary existing is not enough (claw-code lesson).
 */
export function probeSeatbelt(): Promise<SeatbeltProbeResult> {
  if (process.platform !== 'darwin') {
    return Promise.resolve({ supported: false, reason: 'macOS only (Phase A)' });
  }
  if (!fs.existsSync(SANDBOX_EXEC_PATH)) {
    return Promise.resolve({ supported: false, reason: `${SANDBOX_EXEC_PATH} not found` });
  }
  return new Promise((resolve) => {
    execFile(
      SANDBOX_EXEC_PATH,
      ['-p', '(version 1)(allow default)', '/usr/bin/true'],
      { timeout: PROBE_TIMEOUT_MS },
      (error) => {
        if (error) {
          logger.warn('Seatbelt probe failed', { error: error.message });
          resolve({ supported: false, reason: error.message });
        } else {
          resolve({ supported: true });
        }
      },
    );
  });
}
