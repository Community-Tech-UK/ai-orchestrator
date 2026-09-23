/**
 * Passive per-profile quota from live sessions (spec §10): every Claude or
 * Codex session on an account-pool route feeds its account's quota snapshot
 * for free.
 *
 * - Claude `rate_limit_event` (`rate-limit-telemetry` adapter event): one
 *   window per event, classified by `rateLimitType`. A full window also
 *   overrides the usage probe's older "allowed" verdict.
 * - Codex `account/rateLimits/updated` / `account/rateLimits/read`
 *   (`account-rate-limits`): a sparse snapshot merged into the last known one.
 *
 * Each observation MERGES into the profile's current snapshot by window id, so
 * a single-window event never erases windows the active probe reported.
 * Usage access merges too: a Codex update refreshes whether credits are
 * available when it says, and drops the probe's older included-usage verdict,
 * which the newer window numbers may contradict.
 */

import type { EventEmitter } from 'events';
import type { CliRateLimitInfo } from '../../../shared/types/cli.types';
import type { ResolvedAccountRoute } from '../../../shared/types/provider-account.types';
import {
  CLAUDE_ACCOUNT_WIDE_QUOTA_WINDOW_IDS,
  type ProviderQuotaSnapshot,
  type ProviderQuotaWindow,
  type ProviderUsageAccess,
} from '../../../shared/types/provider-quota.types';
import {
  codexRateLimitsToQuotaWindows,
  mergeCodexRateLimitSnapshots,
  parseCodexRateLimitSnapshot,
  type CodexRateLimitSnapshot,
} from '../../cli/adapters/codex/account-rate-limits';
import { getProviderQuotaService } from '../../core/system/provider-quota-service';
import { getLogger } from '../../logging/logger';

const logger = getLogger('AccountTelemetryBridge');

type QuotaIngest = Pick<ReturnType<typeof getProviderQuotaService>, 'getSnapshot' | 'ingestFromAdapter'>;

const CLAUDE_WINDOW_BY_TYPE: Record<string, { id: string; label: string }> = {
  five_hour: { id: 'claude.5h', label: '5-hour session' },
  seven_day: { id: 'claude.weekly', label: 'Weekly (all models)' },
  seven_day_opus: { id: 'claude.weekly-opus', label: 'Weekly (Opus)' },
  seven_day_sonnet: { id: 'claude.weekly-sonnet', label: 'Weekly (Sonnet)' },
};

/** A quota window from one Claude `rate_limit_info`, or null when it carries no usable numbers. */
export function claudeTelemetryWindow(info: CliRateLimitInfo): ProviderQuotaWindow | null {
  const type = info.rateLimitType ?? '';
  const mapping = CLAUDE_WINDOW_BY_TYPE[type] ?? (type.startsWith('seven_day') ? CLAUDE_WINDOW_BY_TYPE['seven_day'] : null);
  if (!mapping) return null;
  let used: number | null = null;
  if (typeof info.utilization === 'number' && Number.isFinite(info.utilization)) {
    used = info.utilization <= 1 ? info.utilization * 100 : info.utilization;
  }
  if (info.status === 'rejected') used = 100;
  if (used === null) return null;
  used = Math.max(0, Math.min(100, used));
  return {
    kind: 'rolling-window',
    id: mapping.id,
    label: mapping.label,
    unit: 'messages',
    used,
    limit: 100,
    remaining: 100 - used,
    resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : null,
  };
}

/**
 * The usage verdict after a live Claude event reports a window full. The
 * probe's older "allowed" must not outlive it: a full account-wide window
 * means the included usage is spent now; a full model-scoped one only makes
 * the account-wide verdict unknown. Credits are kept as they were.
 */
export function claudeAccessAfterFullWindow(
  window: Pick<ProviderQuotaWindow, 'id'>,
  previous: ProviderUsageAccess | undefined,
): ProviderUsageAccess | undefined {
  if (CLAUDE_ACCOUNT_WIDE_QUOTA_WINDOW_IDS.has(window.id)) {
    return { ordinaryUsageAllowed: false, creditsAvailable: previous?.creditsAvailable ?? null, observedAt: Date.now() };
  }
  if (previous?.ordinaryUsageAllowed !== true) return previous;
  return previous.creditsAvailable === null
    ? undefined
    : { ordinaryUsageAllowed: null, creditsAvailable: previous.creditsAvailable, observedAt: previous.observedAt };
}

export function mergeWindows(existing: ProviderQuotaSnapshot | null, windows: ProviderQuotaWindow[]): ProviderQuotaWindow[] {
  const byId = new Map<string, ProviderQuotaWindow>();
  if (existing?.ok) for (const window of existing.windows) byId.set(window.id, window);
  for (const window of windows) byId.set(window.id, window);
  return [...byId.values()];
}

/**
 * Subscribe an adapter's telemetry to its route's profile snapshot. No-op
 * without a route. Returns a teardown.
 */
export function attachAccountTelemetryBridge(
  adapter: Pick<EventEmitter, 'on' | 'off'>,
  route: ResolvedAccountRoute | undefined,
  service: QuotaIngest = getProviderQuotaService(),
): () => void {
  if (!route) return () => undefined;
  const profileId = route.profileId;
  let lastCodex: CodexRateLimitSnapshot | null = null;

  const ingest = (
    windows: ProviderQuotaWindow[],
    plan?: string | null,
    access?: (existing: ProviderUsageAccess | undefined) => ProviderUsageAccess | undefined,
  ): void => {
    if (windows.length === 0) return;
    try {
      const existing = service.getSnapshot(route.provider, profileId);
      const previousAccess = existing?.ok && existing.usageAccess
        ? { ...existing.usageAccess, observedAt: existing.usageAccess.observedAt ?? existing.takenAt }
        : undefined;
      const usageAccess = access ? access(previousAccess) : previousAccess;
      service.ingestFromAdapter(route.provider, {
        provider: route.provider,
        ok: true,
        windows: mergeWindows(existing, windows),
        ...(usageAccess ? { usageAccess } : {}),
        ...(plan ? { plan } : existing?.plan ? { plan: existing.plan } : {}),
      }, 'header', profileId);
    } catch (error) {
      logger.debug('Could not ingest account telemetry', {
        provider: route.provider,
        profileId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const onClaude = (info: CliRateLimitInfo): void => {
    if (route.provider !== 'claude') return;
    const window = claudeTelemetryWindow(info);
    if (!window) return;
    ingest([window], undefined, window.used >= window.limit
      ? (previous) => claudeAccessAfterFullWindow(window, previous)
      : undefined);
  };
  const onCodex = (payload: unknown): void => {
    if (route.provider !== 'codex') return;
    const update = isParsedCodexSnapshot(payload) ? payload : parseCodexRateLimitSnapshot(payload);
    if (!update) return;
    lastCodex = mergeCodexRateLimitSnapshots(lastCodex, update);
    // Only this event's own credits block is new; a merged-in older value keeps its observation time.
    const creditsAvailable = update.creditsAvailable;
    ingest(codexRateLimitsToQuotaWindows(lastCodex), lastCodex.planType, (previous) => {
      if (creditsAvailable !== null) return { ordinaryUsageAllowed: null, creditsAvailable, observedAt: Date.now() };
      if (previous?.creditsAvailable == null) return undefined;
      return { ordinaryUsageAllowed: null, creditsAvailable: previous.creditsAvailable, observedAt: previous.observedAt };
    });
  };

  adapter.on('rate-limit-telemetry', onClaude);
  adapter.on('account-rate-limits', onCodex);
  return () => {
    adapter.off('rate-limit-telemetry', onClaude);
    adapter.off('account-rate-limits', onCodex);
  };
}

/**
 * A raw `account/rateLimits/updated` payload also has `primary` and
 * `rateLimitReachedType`; only the parsed form has `creditsAvailable` (raw
 * carries a `credits` block and resetsAt in seconds).
 */
function isParsedCodexSnapshot(value: unknown): value is CodexRateLimitSnapshot {
  return Boolean(value && typeof value === 'object' && 'primary' in value && 'creditsAvailable' in value);
}
