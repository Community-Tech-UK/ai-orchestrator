/**
 * Provider Quota — types for tracking remaining usage budgets exposed by
 * the underlying CLIs/providers (Claude 5-hour windows, Copilot monthly
 * premium-request caps, Anthropic per-minute rate limits, etc.).
 *
 * This is distinct from `ContextUsage` (per-turn token occupancy) and from
 * `CostTracker` (USD spend). Quota is "how much do I have left right now,
 * before I hit a wall".
 */

/** Providers we currently model. Mirrors `CliType` minus 'cursor'. */
export type ProviderId = 'claude' | 'codex' | 'gemini' | 'copilot';

/**
 * Window kinds:
 * - `rolling-window`: sliding clock (Claude Pro 5-hour, Anthropic per-minute).
 * - `calendar-period`: bounded calendar (Copilot monthly, Gemini daily).
 * - `rate-limit`: instantaneous rate cap from response headers.
 * - `context-window`: per-turn token capacity (mirrors ContextUsage; rare here).
 */
export type QuotaKind =
  | 'rolling-window'
  | 'calendar-period'
  | 'rate-limit'
  | 'context-window';

/** Counting unit for a window. */
export type QuotaUnit = 'requests' | 'messages' | 'tokens' | 'usd';

/**
 * A single quota window for a provider. A provider can publish multiple
 * windows in one snapshot (e.g. Claude Pro: 5-hour-messages + weekly-messages).
 */
export interface ProviderQuotaWindow {
  kind: QuotaKind;
  /**
   * Stable id for the window. Convention: `<provider>.<short-name>` so the
   * UI can keep a window's position stable across refreshes.
   * Examples: `claude.5h-messages`, `claude.weekly-messages`,
   * `copilot.monthly-premium`, `anthropic.per-minute-tokens`.
   */
  id: string;
  /** Human label for display in the UI. */
  label: string;
  unit: QuotaUnit;
  /** Used so far in this window. >= 0. */
  used: number;
  /** Cap for this window. 0 means "unknown" or "unlimited"; UI must handle. */
  limit: number;
  /**
   * Remaining capacity. Convenience field — equals `limit - used` when
   * `limit > 0`, NaN otherwise. Probes should compute this so the UI never
   * has to.
   */
  remaining: number;
  /**
   * Epoch ms when this window resets, or `null` if rolling/unknown.
   * UI uses this to render "resets at 4:18 PM" / "resets in 23 min".
   */
  resetsAt: number | null;
}

/** How a snapshot was obtained — drives the freshness UI. */
export type QuotaSource =
  | 'header'         // Parsed from rate-limit headers in adapter response
  | 'slash-command'  // Active scrape via /usage or equivalent
  | 'cli-result'     // Pulled from the per-turn `result` payload
  | 'admin-api'      // Provider's billing/admin REST endpoint
  | 'inferred';      // Computed from observed activity, no first-party signal

/**
 * The latest known quota state for one provider. We keep one of these per
 * provider; older snapshots are discarded.
 */
export interface ProviderQuotaSnapshot {
  provider: ProviderId;
  /** Epoch ms when the snapshot was produced. */
  takenAt: number;
  source: QuotaSource;
  /**
   * Whether the probe ran successfully. False snapshots carry `error` so the
   * UI can show "stale: <reason>" without throwing the previous good data away.
   */
  ok: boolean;
  error?: string;
  /** May be empty if the probe ran but found no useful windows. */
  windows: ProviderQuotaWindow[];
  /**
   * Plan tier when the probe can determine it: 'pro' | 'max' | 'team' |
   * 'enterprise' | 'api' | 'free'. Free-form so probes can return
   * provider-specific labels (e.g. 'copilot-pro+').
   */
  plan?: string;
}

/** Aggregate state held in the renderer store and main-process service. */
export interface ProviderQuotaState {
  snapshots: Record<ProviderId, ProviderQuotaSnapshot | null>;
}

/**
 * Threshold-crossing alert emitted when a window passes a percentage marker
 * (50/75/90/100). The same window won't re-fire the same threshold until the
 * underlying snapshot is replaced — same pattern as CostTracker budget alerts.
 */
export interface ProviderQuotaAlert {
  provider: ProviderId;
  window: ProviderQuotaWindow;
  /** Percentage threshold crossed (one of [50, 75, 90, 100]). */
  threshold: number;
  /** Epoch ms. */
  timestamp: number;
}
