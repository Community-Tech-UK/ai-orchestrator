/**
 * CopilotUsageEndpointProbe
 *
 * Reads the GitHub Copilot CLI OAuth token from
 * `~/.config/github-copilot/apps.json` and calls
 * `GET https://api.github.com/copilot_internal/user`, matching
 * token-usage-monitor's percentage source.
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

const logger = getLogger('CopilotUsageEndpointProbe');

const USER_URL = 'https://api.github.com/copilot_internal/user';
const USER_AGENT = 'GitHubCopilotCLI/usage-poller';
const DEFAULT_TIMEOUT_MS = 10_000;

export type CopilotAppsReader = (filePath: string) => Promise<string>;

export type CopilotUsageFetch = (
  token: string,
  opts: { signal: AbortSignal; timeoutMs: number },
) => Promise<{ status: number; body: unknown }>;

export interface CopilotUsageEndpointProbeOptions {
  appsPath?: string;
  readFile?: CopilotAppsReader;
  fetchUsage?: CopilotUsageFetch;
  timeoutMs?: number;
}

interface CopilotAppsJson {
  [key: string]: unknown;
}

interface CopilotQuotaBucket {
  unlimited?: boolean;
  percent_remaining?: number | string | null;
}

interface CopilotInternalUserPayload {
  copilot_plan?: string | null;
  access_type_sku?: string | null;
  quota_reset_date_utc?: string | null;
  quota_reset_date?: string | null;
  quota_snapshots?: Record<string, CopilotQuotaBucket> | null;
}

export class CopilotUsageEndpointProbe implements ProviderQuotaProbe {
  readonly provider = 'copilot' as const;

  private readonly appsPath: string;
  private readonly readFile: CopilotAppsReader;
  private readonly fetchUsage: CopilotUsageFetch;
  private readonly timeoutMs: number;

  constructor(opts: CopilotUsageEndpointProbeOptions = {}) {
    this.appsPath = opts.appsPath ?? path.join(os.homedir(), '.config', 'github-copilot', 'apps.json');
    this.readFile = opts.readFile ?? ((p) => fsReadFile(p, 'utf8'));
    this.fetchUsage = opts.fetchUsage ?? defaultFetchUsage;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async probe({ signal }: { signal: AbortSignal }): Promise<ProviderQuotaSnapshot | null> {
    const takenAt = Date.now();
    const token = await this.readToken();
    if (!token) {
      return failedSnapshot(takenAt, 'Copilot CLI is not signed in (no usable github-copilot apps.json token)');
    }

    let status: number;
    let body: unknown;
    try {
      ({ status, body } = await this.fetchUsage(token, { signal, timeoutMs: this.timeoutMs }));
    } catch (err) {
      return failedSnapshot(takenAt, classifyFetchError(err));
    }

    if (status === 401 || status === 403) {
      return failedSnapshot(takenAt, 'Copilot OAuth token rejected (401/403) — re-login may be required');
    }
    if (status === 429) {
      return failedSnapshot(takenAt, 'Copilot usage endpoint rate-limited (429)');
    }
    if (status < 200 || status >= 300) {
      return failedSnapshot(takenAt, `Copilot usage endpoint returned HTTP ${status}`);
    }
    if (body === null || typeof body !== 'object') {
      return failedSnapshot(takenAt, 'Copilot usage endpoint returned an unexpected body');
    }

    const payload = body as CopilotInternalUserPayload;
    const windows = parseCopilotInternalUserPayload(payload);
    if (windows.length === 0) {
      return failedSnapshot(takenAt, 'Copilot usage endpoint returned no metered quota windows');
    }

    return {
      provider: 'copilot',
      takenAt,
      source: 'admin-api',
      ok: true,
      plan: payload.copilot_plan ?? payload.access_type_sku ?? undefined,
      windows,
    };
  }

  private async readToken(): Promise<string | null> {
    let raw: string;
    try {
      raw = await this.readFile(this.appsPath);
    } catch {
      return null;
    }

    let parsed: CopilotAppsJson;
    try {
      parsed = JSON.parse(raw) as CopilotAppsJson;
    } catch {
      return null;
    }

    for (const value of Object.values(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const token = (value as { oauth_token?: unknown }).oauth_token;
      if (typeof token === 'string' && token.length > 0) return token;
    }
    return null;
  }
}

export function parseCopilotInternalUserPayload(
  payload: CopilotInternalUserPayload,
): ProviderQuotaWindow[] {
  const snapshots = payload.quota_snapshots;
  if (!snapshots || typeof snapshots !== 'object') return [];

  const resetAt = parseResetAt(payload.quota_reset_date_utc ?? payload.quota_reset_date);
  const windows: ProviderQuotaWindow[] = [];
  const orderedKeys = ['premium_interactions', 'chat', 'completions'];
  const labels: Record<string, string> = {
    premium_interactions: 'Premium interactions',
    chat: 'Chat',
    completions: 'Completions',
  };

  for (const key of orderedKeys) {
    const bucket = snapshots[key];
    if (!bucket || bucket.unlimited) continue;
    const remaining = numeric(bucket.percent_remaining);
    if (remaining === null) continue;
    const used = clampPct(100 - remaining);
    windows.push({
      kind: 'calendar-period',
      id: `copilot.${key.replace(/_/g, '-')}`,
      label: labels[key] ?? key,
      unit: 'requests',
      used,
      limit: 100,
      remaining: 100 - used,
      resetsAt: resetAt,
    });
  }

  return windows;
}

function numeric(value: number | string | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseResetAt(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function failedSnapshot(takenAt: number, error: string): ProviderQuotaSnapshot {
  return {
    provider: 'copilot',
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
      return 'Copilot usage request aborted/timed out';
    }
  }
  return err instanceof Error
    ? `Copilot usage request failed: ${err.message}`
    : 'Copilot usage request failed';
}

const defaultFetchUsage: CopilotUsageFetch = async (token, { signal, timeoutMs }) => {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const onCallerAbort = () => timeoutController.abort();
  if (signal.aborted) timeoutController.abort();
  else signal.addEventListener('abort', onCallerAbort, { once: true });

  try {
    const response = await fetch(USER_URL, {
      method: 'GET',
      signal: timeoutController.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `token ${token}`,
        'Editor-Version': 'ccusage-poller/1.0',
        'User-Agent': USER_AGENT,
      },
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      logger.debug('Copilot usage endpoint returned a non-JSON body');
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onCallerAbort);
  }
};
