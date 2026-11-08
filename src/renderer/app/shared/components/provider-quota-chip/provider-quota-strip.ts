/**
 * The collapsed quota strip: a two-letter code per provider and one figure per
 * account ("CC 45%·11%·4%"), so every account can be checked at a glance before
 * choosing where to send work. Full names would not leave room for every
 * account's figure in the title bar; the popover names each provider and
 * account, in the same order as the figures here.
 *
 * Pure functions, so the rules are testable without a component.
 */

import type {
  ProviderId,
  ProviderQuotaWindow,
} from '../../../../../shared/types/provider-quota.types';
import { quotaSummaryWindow, type QuotaAccountSection } from '../../../../../shared/utils/provider-quota-account-sections';

export type QuotaChipBand = 'green' | 'yellow' | 'orange' | 'red';

export const BAND_COLORS: Record<QuotaChipBand, { fg: string; bg: string }> = {
  green:  { fg: '#22c55e', bg: 'rgba(34,197,94,0.12)' },
  yellow: { fg: '#eab308', bg: 'rgba(234,179,8,0.12)' },
  orange: { fg: '#f97316', bg: 'rgba(249,115,22,0.12)' },
  red:    { fg: '#ef4444', bg: 'rgba(239,68,68,0.14)' },
};

const STRIP_NEUTRAL_FG = '#d4d4d8';

/** Two-letter strip codes. OpenCode's quota is always the MiMo plan's, shown under "OC". */
const QUOTA_STRIP_CODES: Record<ProviderId, string> = {
  claude: 'CC',
  codex: 'CX',
  gemini: 'GM',
  antigravity: 'AG',
  copilot: 'CP',
  cursor: 'CU',
  grok: 'GX',
  opencode: 'OC',
};

/** One account's figure in the strip. */
export interface QuotaStripPart {
  /** "43%", "43% ⚠" when that account is signed out, "Signed out", "–" with no figure, or the plan name. */
  text: string;
  fg: string;
}

export interface QuotaStripEntry {
  provider: ProviderId;
  /** Two-letter provider code ("CC", "OC"). */
  code: string;
  /** One part per account, in the popover's account order. */
  parts: QuotaStripPart[];
  /** The colour of the worst account, used for the code. */
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

/** Holds the place of an account that has no figure, so figures line up with the popover's accounts. */
const NO_FIGURE = '–';

/**
 * One entry for a provider with a part per account: its summary percentage,
 * a warning glyph when that account is signed out (its last-known figure still
 * shows), "Signed out" when it has no figure, or "–" for any other account
 * with no figure (its check failed, or it reports only a plan). When no account
 * has a figure or is signed out, the plan name of a signed-in account stands
 * in. Null means "nothing to show".
 */
export function quotaStripEntry(
  provider: ProviderId,
  sections: readonly QuotaAccountSection[],
): QuotaStripEntry | null {
  const code = QUOTA_STRIP_CODES[provider];
  const parts: (QuotaStripPart & { severity: number })[] = [];
  let hasFigure = false;
  for (const { snapshot } of sections) {
    // A signed-out account with last-known windows still shows them.
    const summary = snapshot.ok || (snapshot.needsReauth && snapshot.windows.length > 0)
      ? quotaSummaryWindow(snapshot)
      : null;
    if (summary) {
      hasFigure = true;
      const percent = windowPercent(summary);
      parts.push({
        text: `${Math.round(percent)}%${snapshot.needsReauth ? ' ⚠' : ''}`,
        // Signed out reads red even when the last-known figure is low.
        fg: snapshot.needsReauth ? BAND_COLORS.red.fg : stripEntryColor(percent),
        severity: snapshot.needsReauth ? 100 : percent,
      });
    } else if (snapshot.needsReauth) {
      hasFigure = true;
      parts.push({ text: 'Signed out', fg: BAND_COLORS.red.fg, severity: 100 });
    } else {
      parts.push({ text: NO_FIGURE, fg: STRIP_NEUTRAL_FG, severity: -1 });
    }
  }
  if (hasFigure) {
    const worst = parts.reduce((a, b) => (b.severity > a.severity ? b : a));
    return { provider, code, parts: parts.map(({ text, fg }) => ({ text, fg })), fg: worst.fg };
  }
  const withPlan = sections.find(({ snapshot }) => snapshot.ok && snapshot.plan);
  if (withPlan || sections.some(({ snapshot }) => snapshot.ok)) {
    const text = withPlan?.snapshot.plan ?? 'ok';
    return { provider, code, parts: [{ text, fg: STRIP_NEUTRAL_FG }], fg: STRIP_NEUTRAL_FG };
  }
  return null;
}
