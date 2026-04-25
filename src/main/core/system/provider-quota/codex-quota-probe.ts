/**
 * CodexQuotaProbe
 *
 * Probes the local Codex CLI via `codex login status`.
 *
 * IMPORTANT — known limitation
 * ────────────────────────────
 * The Codex CLI's `login status` subcommand returns a single-line text
 * response (e.g. "Logged in using ChatGPT"); there is no `--json` flag and
 * no published per-account rate-limit endpoint. OpenAI's per-user usage
 * endpoints (`/v1/usage`, `/v1/dashboard/billing/usage`) require an API
 * key with billing scope and are not reachable through Codex's OAuth-based
 * auth. The per-turn `result` payload (already parsed by the adapter) does
 * not carry remaining-quota numbers either.
 *
 * Therefore this probe v1 surfaces only:
 *   • login state (logged in / out)
 *   • auth method (chatgpt / api / unknown)
 *
 * EXTENSION POINT: when OpenAI exposes per-user remainders headlessly OR the
 * Codex CLI grows a `--json` output mode for `login status` with quota
 * numbers, populate `windows` in `parseLoginStatus()` below.
 *
 * Spawning uses Node's execFile (no shell, args as array) for safety.
 */

import * as childProc from 'child_process';
import type { ProviderQuotaSnapshot } from '../../../../shared/types/provider-quota.types';
import type { ProviderQuotaProbe } from '../provider-quota-service';
import { getLogger } from '../../../logging/logger';

const logger = getLogger('CodexQuotaProbe');

/** Subprocess result. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CodexLoginStatusExec = (
  command: string,
  args: string[],
  opts: { signal: AbortSignal; timeoutMs: number },
) => Promise<ExecResult>;

export interface CodexQuotaProbeOptions {
  /** Path to the `codex` binary. Defaults to `'codex'` (PATH lookup). */
  cliCommand?: string;
  /** Subprocess timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
  /** Injected exec for testability. */
  exec?: CodexLoginStatusExec;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class CodexQuotaProbe implements ProviderQuotaProbe {
  readonly provider = 'codex' as const;

  private readonly cliCommand: string;
  private readonly timeoutMs: number;
  private readonly exec: CodexLoginStatusExec;

  constructor(opts: CodexQuotaProbeOptions = {}) {
    this.cliCommand = opts.cliCommand ?? 'codex';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.exec = opts.exec ?? defaultExec;
  }

  async probe({ signal }: { signal: AbortSignal }): Promise<ProviderQuotaSnapshot | null> {
    const takenAt = Date.now();
    let result: ExecResult;
    try {
      result = await this.exec(this.cliCommand, ['login', 'status'], {
        signal,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      return failedSnapshot(takenAt, classifyExecError(err));
    }

    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
      logger.debug(`codex login status exited ${result.exitCode}: ${detail}`);
      return failedSnapshot(takenAt, detail);
    }

    // Codex CLI 0.125 writes the status line to stderr (not stdout). Defensively
    // accept either: prefer stdout when populated, fall back to stderr.
    const text = result.stdout.trim() || result.stderr.trim();
    return parseLoginStatus(text, takenAt);
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function failedSnapshot(takenAt: number, error: string): ProviderQuotaSnapshot {
  return {
    provider: 'codex',
    takenAt,
    source: 'cli-result',
    ok: false,
    error,
    windows: [],
  };
}

function classifyExecError(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'ENOENT') {
      return 'codex CLI not found on PATH (is Codex CLI installed?)';
    }
    if (code === 'ETIMEDOUT' || code === 'ABORT_ERR') {
      return 'codex login status timed out';
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse `codex login status` text output into a snapshot.
 * Recognised phrases (as of Codex CLI 0.125):
 *   "Logged in using ChatGPT"      → plan='chatgpt'
 *   "Logged in using API key"      → plan='api'
 *   "Logged in using ..."          → plan='unknown'
 *   anything else / empty / "Not logged in" → ok=false
 */
function parseLoginStatus(stdout: string, takenAt: number): ProviderQuotaSnapshot {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return failedSnapshot(takenAt, 'Codex CLI is not signed in');
  }

  // Logged-out variants the CLI may emit.
  if (/^not logged in$/i.test(trimmed)) {
    return failedSnapshot(takenAt, 'Codex CLI is not signed in');
  }

  const match = /^Logged in using\s+(.+)$/im.exec(trimmed);
  if (!match) {
    return failedSnapshot(takenAt, `Unexpected codex login status output: ${truncate(trimmed, 80)}`);
  }

  const method = match[1].trim().toLowerCase();
  let plan: string;
  if (method === 'chatgpt') {
    plan = 'chatgpt';
  } else if (/api\s*key/.test(method)) {
    plan = 'api';
  } else {
    plan = 'unknown';
  }

  return {
    provider: 'codex',
    takenAt,
    source: 'cli-result',
    ok: true,
    plan,
    // No headless source for remaining quota — see file header.
    windows: [],
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

const defaultExec: CodexLoginStatusExec = (command, args, { signal, timeoutMs }) => {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = childProc.execFile(
      command,
      args,
      { signal, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (settled) return;
        settled = true;
        if (err) {
          const errAny = err as NodeJS.ErrnoException & { code?: string | number };
          if (typeof errAny.code === 'string') return reject(err);
          resolve({
            stdout,
            stderr,
            exitCode: typeof errAny.code === 'number' ? errAny.code : 1,
          });
          return;
        }
        resolve({ stdout, stderr, exitCode: 0 });
      },
    );
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
};
