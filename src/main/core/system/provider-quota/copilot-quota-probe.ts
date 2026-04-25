/**
 * CopilotQuotaProbe
 *
 * Probes local GitHub Copilot CLI state for sign-in status.
 *
 * IMPORTANT — known limitations
 * ─────────────────────────────
 * 1. **No public per-user quota endpoint.** GitHub's documented Copilot
 *    billing endpoints (`/user/copilot_billing/seat`, `/user/copilot_billing`,
 *    etc.) all require admin tokens and are scoped to organisations, not the
 *    individual user. There is no public API that returns "how many premium
 *    requests I have left this month" for a personal Copilot Pro/Pro+
 *    subscription.
 *
 * 2. **No headless `auth status` command.** The Copilot CLI's only auth
 *    surface is the interactive `copilot login`. There is no `copilot auth
 *    status` analog to Claude Code's, and the per-turn `result.usage`
 *    payload (already parsed by the adapter) carries `premiumRequests` /
 *    durations but no remainders or caps.
 *
 * Therefore this probe v1 surfaces only login state. It does so by reading
 * `~/.copilot/config.json` directly — cheaper than spawning the CLI and not
 * dependent on any (currently absent) status subcommand. The format (a
 * `loggedInUsers` array) has been stable since Copilot CLI 0.x.
 *
 * EXTENSION POINT: when GitHub adds a per-user billing endpoint OR the CLI
 * grows a status command that reports plan tier and monthly premium-request
 * remainders, populate `windows` in `parseCopilotConfig()` below. Nothing
 * upstream needs to change.
 *
 * Like the Claude probe, the value here is detecting failure modes the chip
 * needs to show: not installed (no config file), signed out (empty
 * `loggedInUsers`), permission error reading config.
 */

import { readFile as fsReadFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { ProviderQuotaSnapshot } from '../../../../shared/types/provider-quota.types';
import type { ProviderQuotaProbe } from '../provider-quota-service';
import { getLogger } from '../../../logging/logger';

const logger = getLogger('CopilotQuotaProbe');

/** Pluggable file reader. Tests inject a fake; production uses fs/promises. */
export type CopilotConfigReader = (filePath: string) => Promise<string>;

export interface CopilotQuotaProbeOptions {
  /** Override for the Copilot config directory. Defaults to `~/.copilot`. */
  configDir?: string;
  /** Injected reader for testability. Defaults to `fs/promises.readFile`. */
  readFile?: CopilotConfigReader;
}

/** Shape of the relevant subset of `~/.copilot/config.json`. */
interface CopilotConfigJson {
  lastLoggedInUser?: { host?: string; login?: string };
  loggedInUsers?: { host?: string; login?: string }[];
}

export class CopilotQuotaProbe implements ProviderQuotaProbe {
  readonly provider = 'copilot' as const;

  private readonly configPath: string;
  private readonly readFile: CopilotConfigReader;

  constructor(opts: CopilotQuotaProbeOptions = {}) {
    const configDir = opts.configDir ?? path.join(os.homedir(), '.copilot');
    this.configPath = path.join(configDir, 'config.json');
    this.readFile = opts.readFile ?? defaultReader;
  }

  async probe(): Promise<ProviderQuotaSnapshot | null> {
    const takenAt = Date.now();
    let raw: string;
    try {
      raw = await this.readFile(this.configPath);
    } catch (err) {
      return failedSnapshot(takenAt, classifyReadError(err));
    }

    let parsed: CopilotConfigJson;
    try {
      parsed = JSON.parse(stripLineComments(raw)) as CopilotConfigJson;
    } catch (err) {
      logger.debug(`Failed to parse copilot config.json: ${(err as Error).message}`);
      return failedSnapshot(takenAt, 'Failed to parse copilot config.json');
    }

    return parseCopilotConfig(parsed, takenAt);
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function failedSnapshot(takenAt: number, error: string): ProviderQuotaSnapshot {
  return {
    provider: 'copilot',
    takenAt,
    source: 'cli-result',
    ok: false,
    error,
    windows: [],
  };
}

function classifyReadError(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'ENOENT') {
      return 'Copilot CLI is not signed in (no ~/.copilot/config.json found)';
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return 'Permission denied reading ~/.copilot/config.json';
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Map the parsed copilot config to a quota snapshot.
 *
 * EXTENSION POINT: when remaining-quota data becomes available (per-user
 * billing endpoint or new CLI status command), populate `windows` here.
 */
function parseCopilotConfig(
  config: CopilotConfigJson,
  takenAt: number,
): ProviderQuotaSnapshot {
  const users = config.loggedInUsers;
  if (!Array.isArray(users)) {
    return failedSnapshot(takenAt, 'Unexpected copilot config shape (no loggedInUsers array)');
  }
  if (users.length === 0) {
    return {
      provider: 'copilot',
      takenAt,
      source: 'cli-result',
      ok: false,
      error: 'Copilot CLI is not signed in',
      windows: [],
    };
  }

  return {
    provider: 'copilot',
    takenAt,
    source: 'cli-result',
    ok: true,
    // Plan tier is not detectable via the CLI or any public per-user GitHub
    // API endpoint as of this writing. Mark as 'unknown' until either appears.
    plan: 'unknown',
    windows: [],
  };
}

const defaultReader: CopilotConfigReader = async (filePath) => {
  return fsReadFile(filePath, 'utf8');
};

/**
 * Strip JSONC-style line comments where the entire line is a comment.
 * Pattern is anchored to start-of-line (after optional whitespace), so it
 * leaves quoted URL values intact (those slashes never appear at line start).
 * Copilot's auto-managed config only emits full-line comments at the top of
 * the file, so this narrow strip is sufficient. If Copilot ever adds inline
 * comments, swap this for a real JSONC parser.
 */
function stripLineComments(input: string): string {
  return input.replace(/^[ \t]*\/\/.*$/gm, '');
}
