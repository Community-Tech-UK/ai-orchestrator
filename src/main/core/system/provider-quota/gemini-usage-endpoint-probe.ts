/**
 * GeminiUsageEndpointProbe
 *
 * Native, self-contained probe for the Antigravity (formerly Gemini CLI) usage
 * quota. It reads the shared `~/.gemini/oauth_creds.json` credential and calls
 * Google's internal Code Assist quota API directly — no dependency on the
 * standalone token-usage-monitor (`~/.usage/*`).
 *
 * Independence requirements (mirrors the verified monitor flow):
 *   • Host — `daily-cloudcode-pa.googleapis.com`. The non-`daily-` host does not
 *     serve the Antigravity quota.
 *   • User-Agent — must be NEUTRAL. The endpoint returns 403 PERMISSION_DENIED
 *     for any UA containing "antigravity" or the legacy "GeminiCLI-…".
 *   • Project id — discovered self-healingly via the free `loadCodeAssist` call
 *     (it returns `cloudaicompanionProject`), then cached in-memory. No reliance
 *     on the monitor's `~/.usage/gemini_project` file.
 *   • Token refresh — `oauth_creds.json` does not carry the OAuth client, so we
 *     resolve it from (1) env overrides, (2) the creds file if present, then
 *     (3) runtime discovery of the public installed-app client shipped inside
 *     the locally-installed gemini-cli bundle. The secret is therefore never
 *     committed to this repo — it is read at runtime from the user's machine.
 *
 * Read-only token discipline: this probe may use the stored refresh token to
 * obtain a short-lived access token, but it NEVER writes or rotates the stored
 * Gemini credential file.
 *
 * Reauth: when no usable access token can be obtained (signed out, or the
 * refresh token is rejected), the snapshot is returned with `needsReauth: true`
 * so the UI can prompt the user to sign in again.
 */

import { readFile as fsReadFile, readdir, realpath, access } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type {
  ProviderQuotaSnapshot,
  ProviderQuotaWindow,
} from '../../../../shared/types/provider-quota.types';
import type { ProviderQuotaProbe } from '../provider-quota-service';
import { getLogger } from '../../../logging/logger';

const logger = getLogger('GeminiUsageEndpointProbe');

const QUOTA_HOST = 'https://daily-cloudcode-pa.googleapis.com';
const QUOTA_URL = `${QUOTA_HOST}/v1internal:retrieveUserQuota`;
const LOAD_URL = `${QUOTA_HOST}/v1internal:loadCodeAssist`;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Neutral UA — the quota endpoint 403s any UA containing "antigravity"/"GeminiCLI".
const USER_AGENT = 'ai-orchestrator/quota-poller';
const DEFAULT_TIMEOUT_MS = 10_000;
const EXPIRY_SKEW_MS = 90_000;

export type GeminiQuotaFileReader = (filePath: string) => Promise<string>;

export type GeminiQuotaFetch = (
  accessToken: string,
  project: string,
  opts: { signal: AbortSignal; timeoutMs: number },
) => Promise<{ status: number; body: unknown }>;

/** Seeds the `cloudaicompanionProject` id via the free loadCodeAssist call. */
export type GeminiLoadCodeAssistFetch = (
  accessToken: string,
  opts: { signal: AbortSignal; timeoutMs: number },
) => Promise<{ status: number; project: string | null }>;

export type GeminiTokenRefreshFetch = (
  refreshToken: string,
  opts: GeminiTokenRefreshOptions,
) => Promise<{ accessToken: string; expiresInSec: number }>;

/** Resolves the public installed-app OAuth client from the user's machine. */
export type GeminiOAuthClientDiscovery = () => Promise<GeminiOAuthClient | null>;

export interface GeminiTokenRefreshOptions {
  signal: AbortSignal;
  timeoutMs: number;
  clientId?: string;
  clientSecret?: string;
}

export interface GeminiUsageEndpointProbeOptions {
  configDir?: string;
  projectId?: string;
  env?: NodeJS.ProcessEnv;
  readFile?: GeminiQuotaFileReader;
  fetchQuota?: GeminiQuotaFetch;
  fetchLoadCodeAssist?: GeminiLoadCodeAssistFetch;
  refreshToken?: GeminiTokenRefreshFetch;
  discoverOAuthClient?: GeminiOAuthClientDiscovery;
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

/** Outcome of resolving a usable access token. */
interface AccessTokenResult {
  token: string | null;
  /** Why no token — drives the reauth message. Only set when token is null. */
  reason?: 'signed-out' | 'refresh-failed';
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
  // Reports under the `antigravity` provider: the Gemini CLI is deprecated and
  // `agy` (Antigravity) now consumes this same Google quota via the shared
  // ~/.gemini OAuth creds, so the quota belongs to the antigravity surface.
  readonly provider = 'antigravity' as const;

  private readonly configDir: string;
  private readonly projectId: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly readFile: GeminiQuotaFileReader;
  private readonly fetchQuota: GeminiQuotaFetch;
  private readonly fetchLoadCodeAssist: GeminiLoadCodeAssistFetch;
  private readonly refreshToken: GeminiTokenRefreshFetch;
  private readonly discoverOAuthClient: GeminiOAuthClientDiscovery;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  /** In-memory caches so steady-state polls don't re-seed or re-discover. */
  private cachedProject: string | null = null;
  private discoveredClient: GeminiOAuthClient | null = null;
  private clientDiscoveryDone = false;
  /**
   * In-memory cache of a refreshed access token. Antigravity keeps its own
   * token cache rather than rewriting `oauth_creds.json`, so the on-disk token
   * is frequently stale — without this every poll would hit Google's token
   * endpoint. Memory-only: we never write the token back to disk.
   */
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(opts: GeminiUsageEndpointProbeOptions = {}) {
    this.configDir = opts.configDir ?? path.join(os.homedir(), '.gemini');
    this.projectId = opts.projectId;
    this.env = opts.env ?? process.env;
    this.readFile = opts.readFile ?? ((p) => fsReadFile(p, 'utf8'));
    this.fetchQuota = opts.fetchQuota ?? defaultFetchQuota;
    this.fetchLoadCodeAssist = opts.fetchLoadCodeAssist ?? defaultFetchLoadCodeAssist;
    this.refreshToken = opts.refreshToken ?? defaultRefreshToken;
    this.discoverOAuthClient = opts.discoverOAuthClient ?? (() => discoverGeminiOAuthClient(this.env));
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async probe({ signal }: { signal: AbortSignal }): Promise<ProviderQuotaSnapshot | null> {
    const takenAt = Date.now();

    // 1. A usable access token is required for both loadCodeAssist and the quota
    //    call. Failure here is an auth problem the user can fix → needsReauth.
    const { token, reason } = await this.resolveAccessToken(signal);
    if (!token) {
      return failedSnapshot(takenAt, describeTokenFailure(reason), { needsReauth: true });
    }

    // 2. Resolve the project id (configured/env → cache → loadCodeAssist seed).
    const project = await this.resolveProjectId(token, signal);
    if (!project) {
      return failedSnapshot(takenAt, 'Antigravity quota project id is unknown (loadCodeAssist could not seed it)');
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
      return failedSnapshot(
        takenAt,
        'Antigravity OAuth token rejected (401/403) — sign in again',
        { needsReauth: true },
      );
    }
    if (status === 429) {
      return failedSnapshot(takenAt, 'Antigravity quota endpoint rate-limited (429)');
    }
    if (status < 200 || status >= 300) {
      return failedSnapshot(takenAt, `Antigravity quota endpoint returned HTTP ${status}`);
    }
    if (body === null || typeof body !== 'object') {
      return failedSnapshot(takenAt, 'Antigravity quota endpoint returned an unexpected body');
    }

    const windows = parseGeminiQuotaPayload(body as GeminiQuotaPayload);
    if (windows.length === 0) {
      return failedSnapshot(takenAt, 'Antigravity quota endpoint returned no request quota buckets');
    }

    return {
      provider: 'antigravity',
      takenAt,
      source: 'admin-api',
      ok: true,
      plan: 'personal',
      windows,
    };
  }

  private async resolveProjectId(accessToken: string, signal: AbortSignal): Promise<string | null> {
    const configured = this.projectId ?? this.env['AIO_GEMINI_QUOTA_PROJECT'] ?? this.env['GEMINI_QUOTA_PROJECT'];
    if (configured && configured.trim()) return configured.trim();

    if (this.cachedProject) return this.cachedProject;

    // Self-healing discovery: Antigravity's own traffic hits loadCodeAssist
    // (not retrieveUserQuota), and that response carries the project id.
    try {
      const { status, project } = await this.fetchLoadCodeAssist(accessToken, {
        signal,
        timeoutMs: this.timeoutMs,
      });
      if (status === 200 && project && project.trim()) {
        this.cachedProject = project.trim();
        return this.cachedProject;
      }
      logger.debug(`loadCodeAssist could not seed a project id (HTTP ${status})`);
    } catch (err) {
      logger.debug(`loadCodeAssist failed: ${(err as Error).message}`);
    }
    return null;
  }

  private async resolveAccessToken(signal: AbortSignal): Promise<AccessTokenResult> {
    // A previously-refreshed token still in its validity window wins — avoids
    // re-hitting Google's token endpoint on every poll.
    if (this.cachedToken && this.cachedToken.expiresAt > this.now() + EXPIRY_SKEW_MS) {
      return { token: this.cachedToken.token };
    }

    let raw: string;
    try {
      raw = await this.readFile(path.join(this.configDir, 'oauth_creds.json'));
    } catch {
      return { token: null, reason: 'signed-out' };
    }

    let creds: GeminiOAuthCreds;
    try {
      creds = JSON.parse(raw) as GeminiOAuthCreds;
    } catch {
      return { token: null, reason: 'signed-out' };
    }

    const accessToken = creds.access_token;
    const expiryDate = typeof creds.expiry_date === 'number' ? creds.expiry_date : 0;
    if (accessToken && expiryDate > this.now() + EXPIRY_SKEW_MS) {
      return { token: accessToken };
    }

    const refreshToken = creds.refresh_token;
    if (!refreshToken) return { token: null, reason: 'signed-out' };

    const client = await this.resolveOAuthClient(creds);
    if (!client.clientId || !client.clientSecret) {
      // Can't refresh without the OAuth client; the stored token is stale.
      logger.debug('Gemini OAuth client could not be resolved (env / creds / installed CLI)');
      return { token: null, reason: 'refresh-failed' };
    }

    try {
      const refreshed = await this.refreshToken(refreshToken, {
        signal,
        timeoutMs: this.timeoutMs,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
      });
      this.cachedToken = {
        token: refreshed.accessToken,
        expiresAt: this.now() + refreshed.expiresInSec * 1000,
      };
      return { token: refreshed.accessToken };
    } catch (err) {
      logger.debug(`Gemini OAuth refresh failed: ${(err as Error).message}`);
      return { token: null, reason: 'refresh-failed' };
    }
  }

  private async resolveOAuthClient(creds: GeminiOAuthCreds): Promise<GeminiOAuthClient> {
    // 1. Explicit env overrides win.
    const envId = firstTrimmed(this.env['AIO_GEMINI_OAUTH_CLIENT_ID'], this.env['GEMINI_OAUTH_CLIENT_ID']);
    const envSecret = firstTrimmed(this.env['AIO_GEMINI_OAUTH_CLIENT_SECRET'], this.env['GEMINI_OAUTH_CLIENT_SECRET']);
    if (envId && envSecret) return { clientId: envId, clientSecret: envSecret };

    // 2. Some creds files embed the client; honour it when present.
    const credId = firstTrimmed(creds.client_id);
    const credSecret = firstTrimmed(creds.client_secret);
    if (credId && credSecret) return { clientId: credId, clientSecret: credSecret };

    // 3. Discover the public installed-app client from the local gemini-cli
    //    bundle (cached, including the negative result).
    if (!this.clientDiscoveryDone) {
      try {
        this.discoveredClient = await this.discoverOAuthClient();
      } catch (err) {
        logger.debug(`Gemini OAuth client discovery failed: ${(err as Error).message}`);
        this.discoveredClient = null;
      }
      this.clientDiscoveryDone = true;
    }
    return {
      clientId: envId ?? credId ?? this.discoveredClient?.clientId,
      clientSecret: envSecret ?? credSecret ?? this.discoveredClient?.clientSecret,
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

function firstTrimmed(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function describeTokenFailure(reason: AccessTokenResult['reason']): string {
  if (reason === 'refresh-failed') {
    return 'Antigravity session expired and could not be refreshed — run `agy` (or `gemini`) to sign in again';
  }
  return 'Antigravity is not signed in — run `agy` (or `gemini`) to sign in';
}

function failedSnapshot(
  takenAt: number,
  error: string,
  extra?: { needsReauth?: boolean },
): ProviderQuotaSnapshot {
  return {
    provider: 'antigravity',
    takenAt,
    source: 'admin-api',
    ok: false,
    error,
    needsReauth: extra?.needsReauth,
    windows: [],
  };
}

function classifyFetchError(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'name' in err) {
    if ((err as { name?: unknown }).name === 'AbortError') {
      return 'Antigravity quota request aborted/timed out';
    }
  }
  return err instanceof Error
    ? `Antigravity quota request failed: ${err.message}`
    : 'Antigravity quota request failed';
}

/**
 * Discover the public installed-app OAuth client shipped inside the locally
 * installed gemini-cli bundle. The bundle stores it as plain
 * `OAUTH_CLIENT_ID = "…"` / `OAUTH_CLIENT_SECRET = "…"` assignments. Best-effort
 * and read-only; returns null when the CLI isn't installed or the pattern moves.
 *
 * This keeps the (public, non-confidential) client out of this repo — it is read
 * from the user's machine at runtime instead of being committed.
 */
async function discoverGeminiOAuthClient(env: NodeJS.ProcessEnv): Promise<GeminiOAuthClient | null> {
  // Try the live Antigravity CLI binary first (`agy`), then the legacy alias
  // (`gemini`). Both ship the same bundle with the embedded OAuth client.
  const binary = await findExecutableOnPath('agy', env) ?? await findExecutableOnPath('gemini', env);
  if (!binary) return null;

  let resolved = binary;
  try {
    resolved = await realpath(binary);
  } catch {
    /* use the unresolved path */
  }

  const bundleDir = path.dirname(resolved);
  let entries: string[];
  try {
    entries = await readdir(bundleDir);
  } catch {
    return null;
  }

  // The client lives in the main entry + lazily-loaded chunk-*.js files.
  const candidates = entries
    .filter((name) => name.endsWith('.js'))
    .sort((a, b) => Number(b.startsWith('chunk-')) - Number(a.startsWith('chunk-')));

  for (const name of candidates) {
    let text: string;
    try {
      text = await fsReadFile(path.join(bundleDir, name), 'utf8');
    } catch {
      continue;
    }
    const idMatch = /OAUTH_CLIENT_ID\s*=\s*["']([^"']+)["']/.exec(text);
    const secretMatch = /OAUTH_CLIENT_SECRET\s*=\s*["']([^"']+)["']/.exec(text);
    if (idMatch?.[1] && secretMatch?.[1]) {
      return { clientId: idMatch[1], clientSecret: secretMatch[1] };
    }
  }
  return null;
}

async function findExecutableOnPath(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const pathVar = env['PATH'] ?? '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* not here; try next */
    }
  }
  return null;
}

const defaultFetchQuota: GeminiQuotaFetch = async (accessToken, project, { signal, timeoutMs }) => {
  return withTimeout(signal, timeoutMs, async (combinedSignal) => {
    const response = await fetch(QUOTA_URL, {
      method: 'POST',
      signal: combinedSignal,
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
      logger.debug('Antigravity quota endpoint returned a non-JSON body');
    }
    return { status: response.status, body };
  });
};

const defaultFetchLoadCodeAssist: GeminiLoadCodeAssistFetch = async (accessToken, { signal, timeoutMs }) => {
  return withTimeout(signal, timeoutMs, async (combinedSignal) => {
    const response = await fetch(LOAD_URL, {
      method: 'POST',
      signal: combinedSignal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ metadata: { pluginType: 'GEMINI' } }),
    });
    let project: string | null = null;
    try {
      const parsed = (await response.json()) as { cloudaicompanionProject?: unknown };
      if (typeof parsed.cloudaicompanionProject === 'string') {
        project = parsed.cloudaicompanionProject;
      }
    } catch {
      logger.debug('loadCodeAssist returned a non-JSON body');
    }
    return { status: response.status, project };
  });
};

const defaultRefreshToken: GeminiTokenRefreshFetch = async (
  refreshToken,
  { signal, timeoutMs, clientId, clientSecret },
) => {
  if (!clientId || !clientSecret) {
    throw new Error('Gemini OAuth client metadata is not configured');
  }

  return withTimeout(signal, timeoutMs, async (combinedSignal) => {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      signal: combinedSignal,
      body,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const parsed = (await response.json()) as { access_token?: string; expires_in?: number };
    if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
      throw new Error('refresh response did not include access_token');
    }
    return {
      accessToken: parsed.access_token,
      expiresInSec: typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600,
    };
  });
};

/** Run `fn` with a signal that aborts on caller-abort or after `timeoutMs`. */
async function withTimeout<T>(
  signal: AbortSignal,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', onCallerAbort, { once: true });
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onCallerAbort);
  }
}
