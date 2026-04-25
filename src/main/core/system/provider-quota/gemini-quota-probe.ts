/**
 * GeminiQuotaProbe
 *
 * Probes local Gemini CLI state for sign-in status and auth type by reading
 * config files in `~/.gemini/`.
 *
 * IMPORTANT — known limitation
 * ────────────────────────────
 * The Gemini CLI's `/auth` slash command is interactive-only — running it
 * via `gemini -p "/auth"` errors with "command result that is not supported
 * in non-interactive mode". There is no headless `gemini auth status`
 * subcommand.
 *
 * On the API side, Google's Generative AI per-key quota lives in the Cloud
 * Console; the public Gemini API does not expose remaining-quota in
 * response headers or a self-service endpoint reachable via the CLI's
 * OAuth-personal token.
 *
 * Therefore this probe v1 reads two files in `~/.gemini/`:
 *   • `google_accounts.json` — `{ active: string, old: string[] }`. Probe
 *     considers a non-empty `active` value a logged-in state.
 *   • `settings.json`        — `security.auth.selectedType` reveals the
 *     auth method ("oauth-personal" → plan='personal'; "*-api-key" →
 *     plan='api'; otherwise 'unknown').
 *
 * EXTENSION POINT: when Google publishes a per-user quota endpoint reachable
 * via the user's OAuth token, populate `windows` in `parseAccounts()` below.
 */

import { readFile as fsReadFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { ProviderQuotaSnapshot } from '../../../../shared/types/provider-quota.types';
import type { ProviderQuotaProbe } from '../provider-quota-service';
import { getLogger } from '../../../logging/logger';

const logger = getLogger('GeminiQuotaProbe');

/** Pluggable file reader — tests inject a fake. */
export type GeminiFileReader = (filePath: string) => Promise<string>;

export interface GeminiQuotaProbeOptions {
  /** Override for the Gemini config directory. Defaults to `~/.gemini`. */
  configDir?: string;
  /** Injected reader for testability. Defaults to `fs/promises.readFile`. */
  readFile?: GeminiFileReader;
}

/** Shape of `~/.gemini/google_accounts.json`. */
interface GoogleAccountsFile {
  active?: string;
  old?: string[];
}

/** Shape of the relevant subset of `~/.gemini/settings.json`. */
interface GeminiSettingsFile {
  security?: {
    auth?: {
      selectedType?: string;
    };
  };
}

export class GeminiQuotaProbe implements ProviderQuotaProbe {
  readonly provider = 'gemini' as const;

  private readonly accountsPath: string;
  private readonly settingsPath: string;
  private readonly readFile: GeminiFileReader;

  constructor(opts: GeminiQuotaProbeOptions = {}) {
    const configDir = opts.configDir ?? path.join(os.homedir(), '.gemini');
    this.accountsPath = path.join(configDir, 'google_accounts.json');
    this.settingsPath = path.join(configDir, 'settings.json');
    this.readFile = opts.readFile ?? defaultReader;
  }

  async probe(): Promise<ProviderQuotaSnapshot | null> {
    const takenAt = Date.now();

    let accountsRaw: string;
    try {
      accountsRaw = await this.readFile(this.accountsPath);
    } catch (err) {
      return failedSnapshot(takenAt, classifyReadError(err, 'accounts'));
    }

    let accounts: GoogleAccountsFile;
    try {
      accounts = JSON.parse(accountsRaw) as GoogleAccountsFile;
    } catch (err) {
      logger.debug(`Failed to parse google_accounts.json: ${(err as Error).message}`);
      return failedSnapshot(takenAt, 'Failed to parse Gemini google_accounts.json');
    }

    if (!accounts.active || typeof accounts.active !== 'string') {
      return failedSnapshot(takenAt, 'Gemini CLI is not signed in');
    }

    // Best-effort: read settings.json for the auth type. If it fails, we
    // still know the user is signed in; we just don't know the plan tier.
    let plan = 'unknown';
    try {
      const settingsRaw = await this.readFile(this.settingsPath);
      const settings = JSON.parse(settingsRaw) as GeminiSettingsFile;
      const sel = settings.security?.auth?.selectedType;
      plan = mapSelectedTypeToPlan(sel);
    } catch (err) {
      logger.debug(`settings.json unavailable; falling back to plan='unknown' (${(err as Error).message})`);
    }

    return {
      provider: 'gemini',
      takenAt,
      source: 'cli-result',
      ok: true,
      plan,
      windows: [],
    };
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function failedSnapshot(takenAt: number, error: string): ProviderQuotaSnapshot {
  return {
    provider: 'gemini',
    takenAt,
    source: 'cli-result',
    ok: false,
    error,
    windows: [],
  };
}

function classifyReadError(err: unknown, file: 'accounts' | 'settings'): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'ENOENT') {
      return file === 'accounts'
        ? 'Gemini CLI is not signed in (no ~/.gemini/google_accounts.json found)'
        : 'Gemini settings.json missing';
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return `Permission denied reading ~/.gemini/${file === 'accounts' ? 'google_accounts.json' : 'settings.json'}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

function mapSelectedTypeToPlan(selectedType: string | undefined): string {
  if (!selectedType) return 'unknown';
  const t = selectedType.toLowerCase();
  if (t.includes('oauth-personal')) return 'personal';
  if (t.includes('api-key')) return 'api';
  if (t.includes('vertex')) return 'vertex';
  if (t.includes('cloud-shell')) return 'cloud-shell';
  return 'unknown';
}

const defaultReader: GeminiFileReader = async (filePath) => {
  return fsReadFile(filePath, 'utf8');
};
