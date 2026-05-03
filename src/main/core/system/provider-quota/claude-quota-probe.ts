/**
 * ClaudeQuotaProbe
 *
 * Probes the local `claude` CLI for current account/plan state.
 *
 * IMPORTANT — known limitation
 * ────────────────────────────
 * As of Claude Code 2.1.x, the `/usage` slash command is interactive-only.
 * In `--print` (`-p`) mode it returns just a stub message:
 *   "You are currently using your subscription to power your Claude Code usage"
 * — no 5-hour/weekly window numbers, no remaining-message counts, no reset
 * timestamps. The `result` envelope likewise carries only per-call usage,
 * not subscription-window remainders.
 *
 * Therefore this probe currently surfaces ONLY:
 *   • subscription tier (`subscriptionType`: 'pro' | 'max' | undefined → 'api')
 *   • login state and account identity
 *
 * Numerical windows (`5h-messages`, `weekly-messages`) cannot be populated
 * until Anthropic exposes them in the headless surface. When they do, the
 * `parseAuthStatus` function below is the only place that needs to change.
 *
 * Until then, the probe still pulls its weight: it detects logout, missing
 * CLI, and auth errors — failure modes the chip absolutely needs to show.
 *
 * Spawning uses Node's `execFile` (no shell, no string interpolation) for
 * defence-in-depth: the `cliCommand` is treated as a literal binary path and
 * arguments are passed as an array.
 */

import { execFile as execFileCb } from 'child_process';
import type {
  ProviderQuotaSnapshot,
} from '../../../../shared/types/provider-quota.types';
import type { ProviderQuotaProbe } from '../provider-quota-service';
import { getLogger } from '../../../logging/logger';
import { buildCliEnv } from '../../../cli/cli-environment';

const logger = getLogger('ClaudeQuotaProbe');

/** One-shot subprocess invocation result. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Pluggable subprocess runner. Tests inject a fake; production uses the
 * default wrapper around `execFile`.
 */
export type ClaudeAuthStatusExec = (
  command: string,
  args: string[],
  opts: { signal: AbortSignal; timeoutMs: number; env: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

export interface ClaudeQuotaProbeOptions {
  /** Path to the `claude` binary. Defaults to `'claude'` (resolved via PATH). */
  cliCommand?: string;
  /** Subprocess timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
  /** Injected exec for testability. Defaults to a real execFile wrapper. */
  exec?: ClaudeAuthStatusExec;
  /** Injected environment for testability. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injected platform for testability. Defaults to process.platform. */
  platform?: NodeJS.Platform;
}

/** Shape of a successful `claude auth status --json` payload. */
interface AuthStatusJson {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class ClaudeQuotaProbe implements ProviderQuotaProbe {
  readonly provider = 'claude' as const;

  private readonly cliCommand: string;
  private readonly timeoutMs: number;
  private readonly exec: ClaudeAuthStatusExec;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;

  constructor(opts: ClaudeQuotaProbeOptions = {}) {
    this.cliCommand = opts.cliCommand ?? 'claude';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.exec = opts.exec ?? defaultExec;
    this.env = opts.env ?? process.env;
    this.platform = opts.platform ?? process.platform;
  }

  async probe({ signal }: { signal: AbortSignal }): Promise<ProviderQuotaSnapshot | null> {
    const takenAt = Date.now();
    let result: ExecResult;
    try {
      result = await this.exec(this.cliCommand, ['auth', 'status', '--json'], {
        signal,
        timeoutMs: this.timeoutMs,
        env: buildCliEnv(this.env, this.platform),
      });
    } catch (err) {
      return failedSnapshot(takenAt, classifyExecError(err));
    }

    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
      return failedSnapshot(takenAt, detail);
    }

    let parsed: AuthStatusJson;
    try {
      parsed = JSON.parse(result.stdout) as AuthStatusJson;
    } catch (err) {
      logger.debug(`Failed to parse claude auth status output: ${(err as Error).message}`);
      return failedSnapshot(takenAt, 'Failed to parse claude auth status JSON');
    }

    return parseAuthStatus(parsed, takenAt);
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function failedSnapshot(takenAt: number, error: string): ProviderQuotaSnapshot {
  return {
    provider: 'claude',
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
      return 'claude CLI not found on PATH (is Claude Code installed?)';
    }
    if (code === 'ETIMEDOUT' || code === 'ABORT_ERR') {
      return 'claude auth status timed out';
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Map a parsed `claude auth status --json` payload to a quota snapshot.
 *
 * EXTENSION POINT: when Anthropic exposes 5-hour/weekly numerical limits in
 * headless mode (whether via this command or another), populate `windows`
 * here. The rest of the probe and the upstream service do not need to change.
 */
function parseAuthStatus(json: AuthStatusJson, takenAt: number): ProviderQuotaSnapshot {
  // Sanity-check the shape — `loggedIn` is the only field we mandate.
  if (typeof json.loggedIn !== 'boolean') {
    return failedSnapshot(takenAt, 'Unexpected claude auth status shape (no loggedIn)');
  }

  if (!json.loggedIn) {
    return {
      provider: 'claude',
      takenAt,
      source: 'cli-result',
      ok: false,
      error: 'Claude CLI is not signed in',
      windows: [],
    };
  }

  // Logged in. Subscription tier defaults to 'api' when no subscriptionType
  // is reported (typical for ANTHROPIC_API_KEY users).
  const plan = json.subscriptionType?.toLowerCase() ?? 'api';

  return {
    provider: 'claude',
    takenAt,
    source: 'cli-result',
    ok: true,
    plan,
    // Empty until Anthropic exposes numerical limits headlessly. See file header.
    windows: [],
  };
}

/**
 * Production wrapper around Node's `execFile`. Resolves with
 * stdout/stderr/exitCode rather than throwing on non-zero exit (the probe
 * needs to inspect both). Uses no shell — args are passed as an array.
 */
const defaultExec: ClaudeAuthStatusExec = (command, args, { signal, timeoutMs, env }) => {
  return new Promise((resolve, reject) => {
    let settled = false;

    const child = execFileCb(
      command,
      args,
      {
        env,
        signal,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (settled) return;
        settled = true;
        // execFile with default encoding always yields strings.
        if (err) {
          const errAny = err as NodeJS.ErrnoException & { code?: string | number };
          // System errors (ENOENT, ETIMEDOUT, ABORT_ERR, …) reject so the
          // probe's classifier can produce a friendly message.
          if (typeof errAny.code === 'string') return reject(err);
          // Numeric code → ordinary non-zero exit; surface as a result.
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

    // Belt-and-suspenders for early spawn errors (e.g. ENOENT before the
    // callback wires up).
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
};
