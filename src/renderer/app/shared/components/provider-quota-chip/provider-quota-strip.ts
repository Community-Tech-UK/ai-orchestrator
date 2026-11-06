/**
 * The collapsed quota strip: one short provider name and the worst percentage.
 *
 * It used to print two-letter codes (CC, CX, CU, OC, ...) and every account's
 * percentage side by side ("CC100%·11%·4%"), and CU meant Cursor here while
 * every session header used CU for Computer Use. Now each provider shows the
 * name of the account family its allowance belongs to, from `display-names.ts`
 * ("Claude 100%", "MiMo 43%": OpenCode's allowance is always the MiMo plan's);
 * the account-by-account figures are in the popover, which names each account.
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
  /** Short provider name ("Claude", "MiMo"). */
  name: string;
  /** "43%", "43% ⚠" when an account is signed out, "Signed out", or the plan name. */
  text: string;
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
 * One entry for a provider, from all of its accounts: the worst percentage, a
 * warning glyph while any account is signed out (its last-known figure still
 * counts), "Signed out" when no account has a figure to show, or the plan name
 * when the provider reports no windows at all. Null means "nothing to show".
 */
export function quotaStripEntry(
  provider: ProviderId,
  sections: readonly QuotaAccountSection[],
): QuotaStripEntry | null {
  const name = accountFamilyName(provider);
  const percents: number[] = [];
  let signedOut = false;
  for (const { snapshot } of sections) {
    // A signed-out account with last-known windows still shows them.
    const summary = snapshot.ok || (snapshot.needsReauth && snapshot.windows.length > 0)
      ? quotaSummaryWindow(snapshot)
      : null;
    if (summary) percents.push(windowPercent(summary));
    if (snapshot.needsReauth) signedOut = true;
  }
  if (percents.length > 0 || signedOut) {
    const worst = percents.length > 0 ? Math.max(...percents) : null;
    return {
      provider,
      name,
      text: worst === null ? 'Signed out' : `${Math.round(worst)}%${signedOut ? ' ⚠' : ''}`,
      // Signed out reads red even when the last-known figure is low.
      fg: signedOut ? BAND_COLORS.red.fg : stripEntryColor(worst ?? 0),
    };
  }
  const withPlan = sections.find(({ snapshot }) => snapshot.ok && snapshot.plan);
  if (withPlan || sections.some(({ snapshot }) => snapshot.ok)) {
    return { provider, name, text: withPlan?.snapshot.plan ?? 'ok', fg: STRIP_NEUTRAL_FG };
  }
  return null;
}
