/**
 * CodexUsageEndpointProbe
 *
 * Reads Codex's existing ChatGPT OAuth access token from `~/.codex/auth.json`
 * and calls the same free usage endpoint used by token-usage-monitor:
 * `GET https://chatgpt.com/backend-api/wham/usage`.
 *
 * Read-only discipline: this probe never reads or rotates the refresh token.
 */

import { readFile as fsReadFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type {
  ProviderQuotaSnapshot,
  ProviderQuotaWindow,
} from '../../../../shared/types/provider-quota.types';
import type { ProviderQuotaProbe } from '../provider-quota-service';
import { getLogger } from '../../../logging/logger';

const logger = getLogger('CodexUsageEndpointProbe');

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const USER_AGENT = 'codex-cli/usage-poller';
const DEFAULT_TIMEOUT_MS = 10_000;

export type CodexAuthFileReader = (filePath: string) => Promise<string>;

export type CodexUsageFetch = (
  accessToken: string,
  accountId: string,
  opts: { signal: AbortSignal; timeoutMs: number },
) => Promise<{ status: number; body: unknown }>;

export interface CodexUsageEndpointProbeOptions {
  authPath?: string;
  readFile?: CodexAuthFileReader;
  fetchUsage?: CodexUsageFetch;
  timeoutMs?: number;
}

interface CodexAuthJson {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

interface CodexUsageWindowSource {
  used_percent?: number | null;
  reset_at?: number | string | null;
}

interface CodexUsagePayload {
  rate_limit?: {
    limit_reached?: boolean;
    primary_window?: CodexUsageWindowSource | null;
    secondary_window?: CodexUsageWindowSource | null;
  } | null;
}

export class CodexUsageEndpointProbe implements ProviderQuotaProbe {
  readonly provider = 'codex' as const;

  private readonly authPath: string;
  private readonly readFile: CodexAuthFileReader;
  private readonly fetchUsage: CodexUsageFetch;
  private readonly timeoutMs: number;

  constructor(opts: CodexUsageEndpointProbeOptions = {}) {
    this.authPath = opts.authPath ?? path.join(os.homedir(), '.codex', 'auth.json');
    this.readFile = opts.readFile ?? ((p) => fsReadFile(p, 'utf8'));
    this.fetchUsage = opts.fetchUsage ?? defaultFetchUsage;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async probe({ signal }: { signal: AbortSignal }): Promise<ProviderQuotaSnapshot | null> {
    const takenAt = Date.now();
    const credential = await this.readCredential();
    if (!credential) {
      return failedSnapshot(takenAt, 'Codex is not signed in (no usable ~/.codex/auth.json access token)');
    }

    let status: number;
    let body: unknown;
    try {
      ({ status, body } = await this.fetchUsage(credential.accessToken, credential.accountId, {
        signal,
        timeoutMs: this.timeoutMs,
      }));
    } catch (err) {
      return failedSnapshot(takenAt, classifyFetchError(err));
    }

    if (status === 401 || status === 403) {
      return failedSnapshot(takenAt, 'Codex usage token rejected (401/403) — re-login may be required');
    }
    if (status === 429) {
      return failedSnapshot(takenAt, 'Codex usage endpoint rate-limited (429)');
    }
    if (status < 200 || status >= 300) {
      return failedSnapshot(takenAt, `Codex usage endpoint returned HTTP ${status}`);
    }
    if (body === null || typeof body !== 'object') {
      return failedSnapshot(takenAt, 'Codex usage endpoint returned an unexpected body');
    }

    const windows = parseCodexUsagePayload(body as CodexUsagePayload);
    if (windows.length === 0) {
      return failedSnapshot(takenAt, 'Codex usage endpoint returned no rate-limit windows');
    }

    return {
      provider: 'codex',
      takenAt,
      source: 'admin-api',
      ok: true,
      windows,
    };
  }

  private async readCredential(): Promise<{ accessToken: string; accountId: string } | null> {
    let raw: string;
    try {
      raw = await this.readFile(this.authPath);
    } catch {
      return null;
    }

    let parsed: CodexAuthJson;
    try {
      parsed = JSON.parse(raw) as CodexAuthJson;
    } catch {
      return null;
    }

    const accessToken = parsed.tokens?.access_token;
    const accountId = parsed.tokens?.account_id;
    if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
    if (typeof accountId !== 'string' || accountId.length === 0) return null;
    return { accessToken, accountId };
  }
}

export function parseCodexUsagePayload(payload: CodexUsagePayload): ProviderQuotaWindow[] {
  const rateLimit = payload.rate_limit;
  if (!rateLimit || typeof rateLimit !== 'object') return [];

  const windows: ProviderQuotaWindow[] = [];
  const primary = percentWindow('codex.5h', '5-hour', rateLimit.primary_window);
  if (primary) windows.push(primary);
  const secondary = percentWindow('codex.weekly', 'Weekly', rateLimit.secondary_window);
  if (secondary) windows.push(secondary);
  return windows;
}

function percentWindow(
  id: string,
  label: string,
  source: CodexUsageWindowSource | null | undefined,
): ProviderQuotaWindow | null {
  if (!source || typeof source.used_percent !== 'number') return null;
  const used = clampPct(source.used_percent);
  return {
    kind: 'rolling-window',
    id,
    label,
    unit: 'requests',
    used,
    limit: 100,
    remaining: 100 - used,
    resetsAt: parseResetAt(source.reset_at),
  };
}

function parseResetAt(value: number | string | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.length > 0) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return parseResetAt(asNumber);
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function failedSnapshot(takenAt: number, error: string): ProviderQuotaSnapshot {
  return {
    provider: 'codex',
    takenAt,
    source: 'admin-api',
    ok: false,
    error,
    windows: [],
  };
}

function classifyFetchError(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'name' in err) {
    if ((err as { name?: unknown }).name === 'AbortError') {
      return 'Codex usage request aborted/timed out';
    }
  }
  return err instanceof Error
    ? `Codex usage request failed: ${err.message}`
    : 'Codex usage request failed';
}

const defaultFetchUsage: CodexUsageFetch = async (accessToken, accountId, { signal, timeoutMs }) => {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const onCallerAbort = () => timeoutController.abort();
  if (signal.aborted) timeoutController.abort();
  else signal.addEventListener('abort', onCallerAbort, { once: true });

  try {
    const response = await fetch(USAGE_URL, {
      method: 'GET',
      signal: timeoutController.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'chatgpt-account-id': accountId,
        'User-Agent': USER_AGENT,
      },
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      logger.debug('Codex usage endpoint returned a non-JSON body');
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onCallerAbort);
  }
};
