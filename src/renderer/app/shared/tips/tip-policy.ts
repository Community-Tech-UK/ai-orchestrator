import type { TipRelevance, WorkingTip } from './tip-catalogue';

export const WORKING_DELAY_MS = 30_000;
export const TIP_COOLDOWN_MS = 10 * 60_000;
export const TIP_LIFETIME_CAP = 3;

export interface TipContext extends TipRelevance {
  now: number;
  busySince: number | null;
  enabled: boolean;
  composerText: string;
  queuedCount: number;
  lastKeystrokeAt: number | null;
  modalOpen: boolean;
  activeLoop: boolean;
  shownThisLaunch: number;
  lastShownAt: number | null;
  previousTipId: string | null;
  shownThisBusyPeriod: boolean;
  usedCounts: Readonly<Record<string, number>>;
  shownCounts: Readonly<Record<string, number>>;
  shortcuts: Readonly<Record<string, string>>;
}

/** These gates also hide a tip that has already been painted. */
export function tipEnvironmentEligible(context: TipContext): boolean {
  return context.enabled && context.busySince !== null
    && context.now - context.busySince >= WORKING_DELAY_MS
    && context.composerText.length === 0 && context.queuedCount === 0
    && (context.lastKeystrokeAt === null || context.now - context.lastKeystrokeAt >= 5_000)
    && !context.modalOpen && !context.activeLoop;
}

export function pickTip(context: TipContext, catalogue: readonly WorkingTip[]): WorkingTip | null {
  if (!tipEnvironmentEligible(context) || context.shownThisLaunch >= 2 || context.shownThisBusyPeriod
    || (context.lastShownAt !== null && context.now - context.lastShownAt < TIP_COOLDOWN_MS)) return null;
  let best: WorkingTip | null = null;
  for (const tip of catalogue) {
    if (tip.id === context.previousTipId || (context.usedCounts[tip.featureId] ?? 0) > 0
      || (context.shownCounts[tip.id] ?? 0) >= TIP_LIFETIME_CAP
      || (tip.shortcutActionId && !context.shortcuts[tip.shortcutActionId])
      || (tip.relevantWhen && !tip.relevantWhen(context))) continue;
    if (!best || (context.shownCounts[tip.id] ?? 0) < (context.shownCounts[best.id] ?? 0)) best = tip;
  }
  return best;
}
