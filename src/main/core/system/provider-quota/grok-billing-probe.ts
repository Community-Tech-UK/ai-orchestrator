/**
 * GrokBillingProbe
 *
 * Reads Grok Build's OIDC bearer from `~/.grok/auth.json` (portable:
 * `%USERPROFILE%\.grok\auth.json` on Windows via `os.homedir()`) and calls
 * `GET https://cli-chat-proxy.grok.com/v1/billing`.
 *
 * Read-only discipline: this probe never reads or rotates `refresh_token`
 * and never writes credentials. An expired/missing `key` means ok=false.
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

const logger = getLogger('GrokBillingProbe');

const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing';
const USER_AGENT = 'grok-cli/usage-poller';
const DEFAULT_TIMEOUT_MS = 10_000;

export type GrokAuthFileReader = (filePath: string) => Promise<string>;

export type GrokBillingFetch = (
  accessToken: string,
  opts: { signal: AbortSignal; timeoutMs: number },
) => Promise<{ status: number; body: unknown }>;

export interface GrokBillingProbeOptions {
  authPath?: string;
  readFile?: GrokAuthFileReader;
  fetchBilling?: GrokBillingFetch;
  timeoutMs?: number;
  now?: () => number;
}

interface GrokAuthEntry {
  key?: unknown;
  expires_at?: unknown;
  refresh_token?: unknown;
}

interface GrokMoneyNode {
  val?: unknown;
}

interface GrokBillingConfig {
  monthlyLimit?: GrokMoneyNode | number | null;
  used?: GrokMoneyNode | number | null;
  onDemandCap?: GrokMoneyNode | number | null;
  billingPeriodStart?: string | null;
  billingPeriodEnd?: string | null;
  history?: ({ onDemandUsed?: GrokMoneyNode | number | null } | null)[] | null;
}

interface GrokBillingPayload {
  config?: GrokBillingConfig | null;
}

export class GrokBillingProbe implements ProviderQuotaProbe {
  readonly provider = 'grok' as const;

  private readonly authPath: string;
  private readonly readFile: GrokAuthFileReader;
  private readonly fetchBilling: GrokBillingFetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(opts: GrokBillingProbeOptions = {}) {
    this.authPath = opts.authPath ?? path.join(os.homedir(), '.grok', 'auth.json');
    this.readFile = opts.readFile ?? ((p) => fsReadFile(p, 'utf8'));
    this.fetchBilling = opts.fetchBilling ?? defaultFetchBilling;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  async probe({ signal }: { signal: AbortSignal }): Promise<ProviderQuotaSnapshot | null> {
    const takenAt = this.now();
    const credential = await this.readCredential();
    if (!credential.ok) {
      return failedSnapshot(takenAt, credential.error, { needsReauth: credential.needsReauth });
    }

    let status: number;
    let body: unknown;
    try {
      ({ status, body } = await this.fetchBilling(credential.token, {
        signal,
        timeoutMs: this.timeoutMs,
      }));
    } catch (err) {
      return failedSnapshot(takenAt, classifyFetchError(err));
    }

    if (status === 401 || status === 403) {
      return failedSnapshot(
        takenAt,
        'Grok billing token rejected (401/403) — run `grok login` to refresh',
        { needsReauth: true },
      );
    }
    if (status === 429) {
      return failedSnapshot(takenAt, 'Grok billing endpoint rate-limited (429)');
    }
    if (status < 200 || status >= 300) {
      return failedSnapshot(takenAt, `Grok billing endpoint returned HTTP ${status}`);
    }
    if (body === null || typeof body !== 'object') {
      return failedSnapshot(takenAt, 'Grok billing endpoint returned an unexpected body');
    }

    const windows = parseGrokBillingPayload(body as GrokBillingPayload);
    if (windows.length === 0) {
      return failedSnapshot(takenAt, 'Grok billing endpoint returned no usage windows');
    }

    return {
      provider: 'grok',
      takenAt,
      source: 'admin-api',
      ok: true,
      windows,
    };
  }

  private async readCredential(): Promise<
    | { ok: true; token: string }
    | { ok: false; error: string; needsReauth?: boolean }
  > {
    let raw: string;
    try {
      raw = await this.readFile(this.authPath);
    } catch {
      return {
        ok: false,
        error: 'Grok is not signed in (no ~/.grok/auth.json)',
        needsReauth: true,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        error: 'Grok auth.json is malformed — run `grok login` again',
        needsReauth: true,
      };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        error: 'Grok auth.json has an unexpected shape',
        needsReauth: true,
      };
    }

    for (const value of Object.values(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = value as GrokAuthEntry;
      const key = typeof entry.key === 'string' ? entry.key.trim() : '';
      if (!key) continue;

      const expiresAt = parseExpiresAtMs(entry.expires_at);
      if (expiresAt !== null && expiresAt <= this.now()) {
        // The `key` (access token) is short-lived (~5h). When a `refresh_token`
        // is present the Grok CLI silently refreshes it on next use without any
        // browser login ("Tokens auto-refresh silently via the stored
        // refresh_token"). This is NOT a reauth situation — flagging it as one
        // makes the chip scream "Reauth needed" every few hours while the user
        // is perfectly signed in. We deliberately do NOT perform the refresh
        // ourselves (read-only discipline: rotating the refresh token here could
        // invalidate the CLI's live session), so live billing is simply
        // unavailable until the CLI refreshes; the cached usage-monitor windows
        // still surface via CompositeQuotaProbe.
        const hasRefreshToken =
          typeof entry.refresh_token === 'string' && entry.refresh_token.trim().length > 0;
        if (hasRefreshToken) {
          return {
            ok: false,
            error:
              'Grok access token expired; the CLI refreshes it automatically on next use — live billing unavailable until then',
          };
        }
        return {
          ok: false,
          error: 'Grok auth token is expired — run `grok login` to refresh',
          needsReauth: true,
        };
      }
      return { ok: true, token: key };
    }

    return {
      ok: false,
      error: 'Grok is not signed in (no usable OIDC key in ~/.grok/auth.json)',
      needsReauth: true,
    };
  }
}

export function parseGrokBillingPayload(payload: GrokBillingPayload): ProviderQuotaWindow[] {
  const cfg = payload.config;
  if (!cfg || typeof cfg !== 'object') return [];

  const used = moneyVal(cfg.used);
  const limit = moneyVal(cfg.monthlyLimit);
  const onCap = moneyVal(cfg.onDemandCap);
  const resetsAt =
    parseResetsAt(cfg.billingPeriodEnd) ?? parseResetsAt(cfg.billingPeriodStart);

  const windows: ProviderQuotaWindow[] = [];

  if (used !== null || limit !== null) {
    const u = used ?? 0;
    const lim = limit ?? 0;
    // limit === 0 → subscription allotment without prepaid dollar cap; report 0%
    // rather than inventing 100% (Cursor free-plan precedent is different because
    // Cursor itself reports totalPercentUsed=100).
    const pct = lim > 0 ? clampQuotaPercent((u / lim) * 100) : 0;
    windows.push(percentWindow('grok.monthly', 'Monthly', pct, resetsAt));
  }

  if (onCap !== null && onCap > 0) {
    let onUsed = 0;
    const hist = cfg.history;
    if (Array.isArray(hist) && hist.length > 0) {
      const first = hist[0];
      if (first && typeof first === 'object') {
        onUsed = moneyVal(first.onDemandUsed) ?? 0;
      }
    }
    windows.push(
      percentWindow(
        'grok.on-demand',
        'On-demand',
        clampQuotaPercent((onUsed / onCap) * 100),
        resetsAt,
      ),
    );
  }

  return windows;
}

function moneyVal(node: GrokMoneyNode | number | null | undefined): number | null {
  if (typeof node === 'number' && Number.isFinite(node)) return node;
  if (node && typeof node === 'object' && 'val' in node) {
    const v = (node as GrokMoneyNode).val;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function percentWindow(
  id: string,
  label: string,
  used: number,
  resetsAt: number | null,
): ProviderQuotaWindow {
  return {
    kind: 'calendar-period',
    id,
    label,
    unit: 'usd',
    used,
    limit: 100,
    remaining: quotaRemaining(100, used),
    resetsAt,
  };
}

function parseResetsAt(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function parseExpiresAtMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function failedSnapshot(
  takenAt: number,
  error: string,
  extra?: { needsReauth?: boolean },
): ProviderQuotaSnapshot {
  return {
    provider: 'grok',
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
      return 'Grok billing request aborted/timed out';
    }
  }
  return err instanceof Error
    ? `Grok billing request failed: ${err.message}`
    : 'Grok billing request failed';
}

const defaultFetchBilling: GrokBillingFetch = async (accessToken, { signal, timeoutMs }) => {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const onCallerAbort = () => timeoutController.abort();
  if (signal.aborted) timeoutController.abort();
  else signal.addEventListener('abort', onCallerAbort, { once: true });

  try {
    const response = await fetch(BILLING_URL, {
      method: 'GET',
      signal: timeoutController.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': USER_AGENT,
      },
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      logger.debug('Grok billing endpoint returned a non-JSON body');
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onCallerAbort);
  }
};
