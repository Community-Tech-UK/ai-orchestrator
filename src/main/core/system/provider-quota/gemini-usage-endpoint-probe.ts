/**
 * GeminiUsageEndpointProbe
 *
 * Native, self-contained probe for the Antigravity (AGY) usage quota. It calls
 * Google's internal Code Assist quota-summary API directly — no dependency on
 * the standalone token-usage-monitor (`~/.usage/*`).
 *
 * Credential (keychain-first, mirrors the verified monitor flow):
 *   • AGY 1.1.1 stores its active consumer credential in the OS keyring
 *     ({@link AgyCredentialsReader}: macOS service `gemini`, account
 *     `antigravity`). AGY keeps this access token fresh in place, so it is the
 *     source of truth. Read-only — never written, refreshed, or rotated.
 *   • Fallback for older installs / non-mac: the shared `~/.gemini/oauth_creds.json`
 *     credential, with a read-only refresh via the public installed-app OAuth
 *     client discovered at runtime. Never written back to disk.
 *
 * Endpoint requirements:
 *   • Host — `daily-cloudcode-pa.googleapis.com`. The non-`daily-` host does not
 *     serve the Antigravity quota.
 *   • Path — `:retrieveUserQuotaSummary` (grouped 5-hour + weekly buckets). The
 *     obsolete `:retrieveUserQuota` endpoint returns every remainingFraction=1
 *     and is not used.
 *   • User-Agent — must be AGY-compatible. The summary endpoint returns 403
 *     PERMISSION_DENIED for the neutral legacy UA.
 *   • Project id — discovered self-healingly via the free `loadCodeAssist` call
 *     (it returns `cloudaicompanionProject`), then cached in-memory.
 *
 * Reauth: when no usable access token can be obtained (signed out, or the
 * refresh token is rejected) or the endpoint returns 401/403, the snapshot is
 * returned with `needsReauth: true` so the UI can prompt the user to sign in.
 */

import { readFile as fsReadFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type {
  ProviderQuotaSnapshot,
  ProviderQuotaWindow,
} from '../../../../shared/types/provider-quota.types';
import {
  clampQuotaPercent,
  quotaRemaining,
} from '../../../../shared/util/provider-quota-format';
import type { ProviderQuotaProbe } from '../provider-quota-service';
import { getLogger } from '../../../logging/logger';
import { AgyCredentialsReader, type AgyCredentialResult } from './agy-credentials-reader';
import {
  discoverGeminiOAuthClient,
  type GeminiOAuthClient,
} from './gemini-oauth-client-discovery';

// Re-exported so existing importers (and tests) keep a single entry point.
export {
  discoverGeminiOAuthClient,
  type GeminiOAuthClient,
  type GeminiOAuthDiscoveryDeps,
} from './gemini-oauth-client-discovery';

const logger = getLogger('GeminiUsageEndpointProbe');

const QUOTA_HOST = 'https://daily-cloudcode-pa.googleapis.com';
const QUOTA_URL = `${QUOTA_HOST}/v1internal:retrieveUserQuotaSummary`;
const LOAD_URL = `${QUOTA_HOST}/v1internal:loadCodeAssist`;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// AGY-compatible UA — the summary endpoint 403s the neutral legacy UA.
const USER_AGENT = 'antigravity-cli/1.1.1';
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

/** Reads AGY's keyring credential — the keychain-first source of truth. */
export type AgyCredentialReadFn = () => Promise<AgyCredentialResult>;

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
  /** Reads AGY's keyring credential. Defaults to {@link AgyCredentialsReader}. */
  readAgyCredential?: AgyCredentialReadFn;
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

/** Outcome of resolving a usable access token. */
interface AccessTokenResult {
  token: string | null;
  /** Why no token — drives the reauth message. Only set when token is null. */
  reason?: 'signed-out' | 'refresh-failed';
}

/** A single bucket in a `retrieveUserQuotaSummary` group. */
interface GeminiSummaryBucket {
  bucketId?: string | null;
  displayName?: string | null;
  /** Window kind, e.g. `5h` or `weekly`. */
  window?: string | null;
  remainingFraction?: number | string | null;
  resetTime?: string | null;
}

/** A group of buckets sharing a weekly + 5-hour limit (e.g. "Gemini Models"). */
interface GeminiSummaryGroup {
  displayName?: string | null;
  description?: string | null;
  buckets?: GeminiSummaryBucket[] | null;
}

interface GeminiQuotaSummaryPayload {
  groups?: GeminiSummaryGroup[] | null;
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
  private readonly readAgyCredential: AgyCredentialReadFn;
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
    this.readAgyCredential = opts.readAgyCredential ?? (() => new AgyCredentialsReader().read());
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

    const windows = parseGeminiQuotaSummary(body as GeminiQuotaSummaryPayload);
    if (windows.length === 0) {
      return failedSnapshot(takenAt, 'Antigravity quota endpoint returned no usable quota buckets');
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

    // 1. AGY keyring (the signed-in source of truth; AGY keeps it fresh in
    //    place). Read-only. Fall through to the file source when unavailable.
    try {
      const { credential } = await this.readAgyCredential();
      if (credential && (credential.expiresAt === 0 || credential.expiresAt > this.now() + EXPIRY_SKEW_MS)) {
        return { token: credential.accessToken };
      }
    } catch (err) {
      logger.debug(`Antigravity keyring credential read failed: ${(err as Error).message}`);
    }

    // 2. Fallback: the retired Gemini CLI's ~/.gemini/oauth_creds.json, with a
    //    read-only public-client refresh (never written back to disk).
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

/**
 * Normalize a `retrieveUserQuotaSummary` payload into quota windows.
 *
 * Each group (e.g. "Gemini Models", "Claude and GPT models") carries buckets
 * sharing a 5-hour and a weekly limit. We emit one window per bucket, ordered
 * five-hour before weekly within each group and preserving group order, so the
 * canonical set is: Gemini 5-hour, Gemini weekly, Claude/GPT 5-hour, Claude/GPT
 * weekly. Unknown future groups/buckets are still normalized as long as they
 * carry a usable display name and numeric remaining fraction.
 */
export function parseGeminiQuotaSummary(payload: GeminiQuotaSummaryPayload): ProviderQuotaWindow[] {
  const groups = payload.groups;
  if (!Array.isArray(groups) || groups.length === 0) return [];

  const windows: ProviderQuotaWindow[] = [];
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    const groupDisplay = typeof group.displayName === 'string' ? group.displayName : '';
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    // Stable sort (Node's Array.sort is stable) so 5-hour precedes weekly while
    // any unknown windows keep their original relative order at the end.
    const ordered = buckets
      .filter((b): b is GeminiSummaryBucket => !!b && typeof b === 'object')
      .sort((a, b) => windowRank(a.window) - windowRank(b.window));
    for (const bucket of ordered) {
      const remaining = numeric(bucket.remainingFraction);
      if (remaining === null) continue;
      const used = clampQuotaPercent((1 - remaining) * 100);
      windows.push({
        kind: 'rolling-window',
        id: windowId(groupDisplay, bucket),
        label: windowLabel(groupDisplay, bucket),
        unit: 'requests',
        used,
        limit: 100,
        remaining: quotaRemaining(100, used),
        resetsAt: parseResetAt(bucket.resetTime),
      });
    }
  }
  return windows;
}

/** Rank windows so five-hour renders before weekly; unknowns sort last. */
function windowRank(window: string | null | undefined): number {
  const w = (window ?? '').toLowerCase();
  if (w === '5h' || w.includes('5-hour') || w.includes('five')) return 0;
  if (w === 'weekly' || w.includes('week')) return 1;
  return 2;
}

/**
 * Stable window id derived from the provider plus the bucket id (e.g.
 * `antigravity.gemini-5h`). Falls back to a slug of the group + window when a
 * future response omits a bucket id.
 */
function windowId(groupDisplay: string, bucket: GeminiSummaryBucket): string {
  const bucketId = typeof bucket.bucketId === 'string' ? bucket.bucketId.trim() : '';
  if (bucketId) return `antigravity.${bucketId}`;
  const groupSlug = slug(groupDisplay) || 'group';
  const windowSlug = slug(bucket.window ?? bucket.displayName ?? '') || 'window';
  return `antigravity.${groupSlug}-${windowSlug}`;
}

/** Human label retaining both group and window meaning, e.g. "Gemini · 5-hour". */
function windowLabel(groupDisplay: string, bucket: GeminiSummaryBucket): string {
  const group = groupTag(groupDisplay);
  const window = windowTag(bucket.window, bucket.displayName);
  return `${group} · ${window}`;
}

function groupTag(groupDisplay: string): string {
  const d = groupDisplay.toLowerCase();
  if (d.includes('gemini')) return 'Gemini';
  if (d.includes('claude') || d.includes('gpt')) return 'Claude/GPT';
  return groupDisplay.trim() || 'Models';
}

function windowTag(window: string | null | undefined, bucketDisplay: string | null | undefined): string {
  const w = (window ?? '').toLowerCase();
  if (w === '5h' || w.includes('5-hour') || w.includes('five')) return '5-hour';
  if (w === 'weekly' || w.includes('week')) return 'weekly';
  return (window ?? '').trim() || (bucketDisplay ?? '').trim() || 'window';
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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
