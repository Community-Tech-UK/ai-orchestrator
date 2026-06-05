/**
 * GeminiUsageEndpointProbe
 *
 * Reads Gemini CLI OAuth credentials and calls
 * `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`.
 *
 * Read-only token discipline: this probe may use the stored refresh token to
 * obtain a short-lived access token, but it never writes or rotates the stored
 * Gemini CLI credential file.
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

const logger = getLogger('GeminiUsageEndpointProbe');

const QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USER_AGENT = 'GeminiCLI-usage-poller';
const DEFAULT_TIMEOUT_MS = 10_000;
const EXPIRY_SKEW_MS = 90_000;

export type GeminiQuotaFileReader = (filePath: string) => Promise<string>;

export type GeminiQuotaFetch = (
  accessToken: string,
  project: string,
  opts: { signal: AbortSignal; timeoutMs: number },
) => Promise<{ status: number; body: unknown }>;

export type GeminiTokenRefreshFetch = (
  refreshToken: string,
  opts: GeminiTokenRefreshOptions,
) => Promise<{ accessToken: string; expiresInSec: number }>;

export interface GeminiTokenRefreshOptions {
  signal: AbortSignal;
  timeoutMs: number;
  clientId?: string;
  clientSecret?: string;
}

export interface GeminiUsageEndpointProbeOptions {
  configDir?: string;
  usageDir?: string;
  projectId?: string;
  env?: NodeJS.ProcessEnv;
  readFile?: GeminiQuotaFileReader;
  fetchQuota?: GeminiQuotaFetch;
  refreshToken?: GeminiTokenRefreshFetch;
  now?: () => number;
  timeoutMs?: number;
}

interface GeminiOAuthCreds {
  access_token?: string;
  expiry_date?: number;
  refresh_token?: string;
  client_id?: string;
  client_secret?: string;
}

interface GeminiOAuthClient {
  clientId?: string;
  clientSecret?: string;
}

interface GeminiQuotaBucket {
  modelId?: string | null;
  remainingFraction?: number | string | null;
  resetTime?: string | null;
}

interface GeminiQuotaPayload {
  buckets?: GeminiQuotaBucket[] | null;
}

export class GeminiUsageEndpointProbe implements ProviderQuotaProbe {
  readonly provider = 'gemini' as const;

  private readonly configDir: string;
  private readonly usageDir: string;
  private readonly projectId: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly readFile: GeminiQuotaFileReader;
  private readonly fetchQuota: GeminiQuotaFetch;
  private readonly refreshToken: GeminiTokenRefreshFetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(opts: GeminiUsageEndpointProbeOptions = {}) {
    this.configDir = opts.configDir ?? path.join(os.homedir(), '.gemini');
    this.usageDir = opts.usageDir ?? path.join(os.homedir(), '.usage');
    this.projectId = opts.projectId;
    this.env = opts.env ?? process.env;
    this.readFile = opts.readFile ?? ((p) => fsReadFile(p, 'utf8'));
    this.fetchQuota = opts.fetchQuota ?? defaultFetchQuota;
    this.refreshToken = opts.refreshToken ?? defaultRefreshToken;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async probe({ signal }: { signal: AbortSignal }): Promise<ProviderQuotaSnapshot | null> {
    const takenAt = Date.now();
    const project = await this.resolveProjectId();
    if (!project) {
      return failedSnapshot(takenAt, 'Gemini quota project id is unknown');
    }

    const token = await this.resolveAccessToken(signal);
    if (!token) {
      return failedSnapshot(takenAt, 'Gemini CLI is not signed in (no usable OAuth access token)');
    }

    let status: number;
    let body: unknown;
    try {
      ({ status, body } = await this.fetchQuota(token, project, {
        signal,
        timeoutMs: this.timeoutMs,
      }));
    } catch (err) {
      return failedSnapshot(takenAt, classifyFetchError(err));
    }

    if (status === 401 || status === 403) {
      return failedSnapshot(takenAt, 'Gemini OAuth token rejected (401/403) — re-login may be required');
    }
    if (status === 429) {
      return failedSnapshot(takenAt, 'Gemini quota endpoint rate-limited (429)');
    }
    if (status < 200 || status >= 300) {
      return failedSnapshot(takenAt, `Gemini quota endpoint returned HTTP ${status}`);
    }
    if (body === null || typeof body !== 'object') {
      return failedSnapshot(takenAt, 'Gemini quota endpoint returned an unexpected body');
    }

    const windows = parseGeminiQuotaPayload(body as GeminiQuotaPayload);
    if (windows.length === 0) {
      return failedSnapshot(takenAt, 'Gemini quota endpoint returned no request quota buckets');
    }

    return {
      provider: 'gemini',
      takenAt,
      source: 'admin-api',
      ok: true,
      plan: 'personal',
      windows,
    };
  }

  private async resolveProjectId(): Promise<string | null> {
    const configured = this.projectId ?? this.env['AIO_GEMINI_QUOTA_PROJECT'] ?? this.env['GEMINI_QUOTA_PROJECT'];
    if (configured && configured.trim()) return configured.trim();

    try {
      const cached = await this.readFile(path.join(this.usageDir, 'gemini_project'));
      const trimmed = cached.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  private async resolveAccessToken(signal: AbortSignal): Promise<string | null> {
    let raw: string;
    try {
      raw = await this.readFile(path.join(this.configDir, 'oauth_creds.json'));
    } catch {
      return null;
    }

    let creds: GeminiOAuthCreds;
    try {
      creds = JSON.parse(raw) as GeminiOAuthCreds;
    } catch {
      return null;
    }

    const accessToken = creds.access_token;
    const expiryDate = typeof creds.expiry_date === 'number' ? creds.expiry_date : 0;
    if (accessToken && expiryDate > this.now() + EXPIRY_SKEW_MS) return accessToken;

    const refreshToken = creds.refresh_token;
    if (!refreshToken) return null;

    try {
      const refreshed = await this.refreshToken(refreshToken, {
        signal,
        timeoutMs: this.timeoutMs,
        ...this.resolveOAuthClient(creds),
      });
      return refreshed.accessToken;
    } catch (err) {
      logger.debug(`Gemini OAuth refresh failed: ${(err as Error).message}`);
      return null;
    }
  }

  private resolveOAuthClient(creds: GeminiOAuthCreds): GeminiOAuthClient {
    return {
      clientId: firstTrimmed(
        this.env['AIO_GEMINI_OAUTH_CLIENT_ID'],
        this.env['GEMINI_OAUTH_CLIENT_ID'],
        creds.client_id,
      ),
      clientSecret: firstTrimmed(
        this.env['AIO_GEMINI_OAUTH_CLIENT_SECRET'],
        this.env['GEMINI_OAUTH_CLIENT_SECRET'],
        creds.client_secret,
      ),
    };
  }
}

export function parseGeminiQuotaPayload(payload: GeminiQuotaPayload): ProviderQuotaWindow[] {
  const buckets = payload.buckets;
  if (!Array.isArray(buckets) || buckets.length === 0) return [];

  const aggregate = new Map<string, { minRemaining: number; resetAt: number | null }>();
  for (const bucket of buckets) {
    const family = familyOf(bucket.modelId);
    if (!family) continue;
    const remaining = numeric(bucket.remainingFraction);
    if (remaining === null) continue;
    const resetAt = parseResetAt(bucket.resetTime);
    const current = aggregate.get(family);
    if (!current || remaining < current.minRemaining) {
      aggregate.set(family, { minRemaining: remaining, resetAt });
    } else if (resetAt && (!current.resetAt || resetAt < current.resetAt)) {
      current.resetAt = resetAt;
    }
  }

  const windows: ProviderQuotaWindow[] = [];
  const order: { family: string; id: string; label: string }[] = [
    { family: 'pro', id: 'gemini.pro-daily', label: 'Pro daily' },
    { family: 'flash-lite', id: 'gemini.flash-lite-daily', label: 'Flash-lite daily' },
    { family: 'flash', id: 'gemini.flash-daily', label: 'Flash daily' },
  ];
  for (const item of order) {
    const entry = aggregate.get(item.family);
    if (!entry) continue;
    const used = clampPct((1 - entry.minRemaining) * 100);
    windows.push({
      kind: 'calendar-period',
      id: item.id,
      label: item.label,
      unit: 'requests',
      used,
      limit: 100,
      remaining: 100 - used,
      resetsAt: entry.resetAt,
    });
  }
  return windows;
}

function familyOf(modelId: string | null | undefined): string | null {
  const model = (modelId ?? '').toLowerCase();
  if (model.includes('pro')) return 'pro';
  if (model.includes('flash-lite') || model.includes('flash_lite')) return 'flash-lite';
  if (model.includes('flash')) return 'flash';
  return null;
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
  const clamped = Math.max(0, Math.min(100, value));
  return Math.round(clamped * 1000) / 1000;
}

function firstTrimmed(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function failedSnapshot(takenAt: number, error: string): ProviderQuotaSnapshot {
  return {
    provider: 'gemini',
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
      return 'Gemini quota request aborted/timed out';
    }
  }
  return err instanceof Error
    ? `Gemini quota request failed: ${err.message}`
    : 'Gemini quota request failed';
}

const defaultFetchQuota: GeminiQuotaFetch = async (accessToken, project, { signal, timeoutMs }) => {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const onCallerAbort = () => timeoutController.abort();
  if (signal.aborted) timeoutController.abort();
  else signal.addEventListener('abort', onCallerAbort, { once: true });

  try {
    const response = await fetch(QUOTA_URL, {
      method: 'POST',
      signal: timeoutController.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ project }),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      logger.debug('Gemini quota endpoint returned a non-JSON body');
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onCallerAbort);
  }
};

const defaultRefreshToken: GeminiTokenRefreshFetch = async (
  refreshToken,
  { signal, timeoutMs, clientId, clientSecret },
) => {
  if (!clientId || !clientSecret) {
    throw new Error('Gemini OAuth client metadata is not configured');
  }

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const onCallerAbort = () => timeoutController.abort();
  if (signal.aborted) timeoutController.abort();
  else signal.addEventListener('abort', onCallerAbort, { once: true });

  try {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      signal: timeoutController.signal,
      body,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const parsed = await response.json() as { access_token?: string; expires_in?: number };
    if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
      throw new Error('refresh response did not include access_token');
    }
    return {
      accessToken: parsed.access_token,
      expiresInSec: typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600,
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onCallerAbort);
  }
};
