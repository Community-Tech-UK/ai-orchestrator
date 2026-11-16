/**
 * The collapsed quota strip: the provider's short name and its worst figure
 * ("Claude 45%"). The popover names each account and gives every figure. Names
 * come from `display-names.ts`, so the strip never uses two-letter codes (CU
 * once meant Cursor here and Computer Use elsewhere).
 *
 * Pure functions, so the rules are testable without a component.
 */

import type {
  ProviderId,
  ProviderQuotaWindow,
} from '../../../../../shared/types/provider-quota.types';
import { accountFamilyName } from '../../../../../shared/display-names';
import { quotaSummaryWindow, type QuotaAccountSection } from '../../../../../shared/utils/provider-quota-account-sections';

export type QuotaChipBand = 'green' | 'yellow' | 'orange' | 'red';

export const BAND_COLORS: Record<QuotaChipBand, { fg: string; bg: string }> = {
  green:  { fg: '#22c55e', bg: 'rgba(34,197,94,0.12)' },
  yellow: { fg: '#eab308', bg: 'rgba(234,179,8,0.12)' },
  orange: { fg: '#f97316', bg: 'rgba(249,115,22,0.12)' },
  red:    { fg: '#ef4444', bg: 'rgba(239,68,68,0.14)' },
};

const STRIP_NEUTRAL_FG = '#d4d4d8';

export interface QuotaStripEntry {
  provider: ProviderId;
  /** Short provider name ("Claude", "MiMo" for OpenCode's plan). */
  name: string;
  /** The worst account's figure: "43%", "43% ⚠" when it is signed out, "Signed out", or the plan name. */
  text: string;
  /** The colour of that figure. */
  fg: string;
}

export function windowPercent(window: ProviderQuotaWindow): number {
  if (window.limit <= 0) return 0;
  return Math.max(0, Math.min(100, (window.used / window.limit) * 100));
}

function stripEntryColor(percent: number): string {
  if (percent >= 90) return BAND_COLORS.red.fg;
  if (percent >= 75) return BAND_COLORS.orange.fg;
  return STRIP_NEUTRAL_FG;
}

/**
 * One entry for a provider: the worst account's summary percentage, with a
 * warning glyph when that account is signed out (its last-known figure still
 * shows), or "Signed out" when it has no figure. A signed-out account counts as
 * the worst. Accounts with no figure (their check failed, or they report only a
 * plan) are skipped; when no account has a figure or is signed out, the plan
 * name of a signed-in account stands in. Null means "nothing to show".
 */
export function quotaStripEntry(
  provider: ProviderId,
  sections: readonly QuotaAccountSection[],
): QuotaStripEntry | null {
  const name = accountFamilyName(provider);
  let worst: { text: string; fg: string; severity: number } | null = null;
  for (const { snapshot } of sections) {
    // A signed-out account with last-known windows still shows them.
    const summary = snapshot.ok || (snapshot.needsReauth && snapshot.windows.length > 0)
      ? quotaSummaryWindow(snapshot)
      : null;
    let candidate: { text: string; fg: string; severity: number } | null = null;
    if (summary) {
      const percent = windowPercent(summary);
      candidate = {
        text: `${Math.round(percent)}%${snapshot.needsReauth ? ' ⚠' : ''}`,
        // Signed out reads red even when the last-known figure is low.
        fg: snapshot.needsReauth ? BAND_COLORS.red.fg : stripEntryColor(percent),
        severity: snapshot.needsReauth ? 100 : percent,
      };
    } else if (snapshot.needsReauth) {
      candidate = { text: 'Signed out', fg: BAND_COLORS.red.fg, severity: 100 };
    }
    if (candidate && (!worst || candidate.severity > worst.severity)) worst = candidate;
  }
  if (worst) return { provider, name, text: worst.text, fg: worst.fg };
  const withPlan = sections.find(({ snapshot }) => snapshot.ok && snapshot.plan);
  if (withPlan || sections.some(({ snapshot }) => snapshot.ok)) {
    return { provider, name, text: withPlan?.snapshot.plan ?? 'ok', fg: STRIP_NEUTRAL_FG };
  }
  return null;
}
