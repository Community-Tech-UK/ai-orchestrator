/**
 * The plan-window line at the top of "Where your usage went".
 *
 * James is on subscriptions, so the card leads with how much of the Claude weekly
 * allowance is used and when it resets, before any cause. The numbers come from the
 * quota probe's own snapshot; with no good snapshot there is no line at all.
 */

import type { ProviderQuotaSnapshot } from '../../../../shared/types/provider-quota.types';

const WEEKLY_WINDOW_ID = 'claude.weekly';
const SOON_MS = 12 * 60 * 60 * 1000;

export interface PlanWindowLine {
  percentUsed: number;
  text: string;
}

function resetText(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null || !Number.isFinite(resetsAt) || resetsAt <= now) return null;
  const date = new Date(resetsAt);
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (resetsAt - now <= SOON_MS) return `resets at ${time}`;
  return `resets on ${date.toLocaleDateString('en-GB', { weekday: 'long' })} at ${time}`;
}

/** The most-used Claude weekly window across the default account and any signed-in accounts. */
export function claudeWeeklyPlanLine(
  snapshots: readonly (ProviderQuotaSnapshot | null | undefined)[],
  now: number,
): PlanWindowLine | null {
  let best: { ratio: number; resetsAt: number | null } | null = null;
  for (const snapshot of snapshots) {
    if (!snapshot || snapshot.provider !== 'claude' || !snapshot.ok) continue;
    for (const window of snapshot.windows) {
      if (window.id !== WEEKLY_WINDOW_ID || window.limit <= 0 || window.overage === true) continue;
      const ratio = window.used / window.limit;
      if (!best || ratio > best.ratio) best = { ratio, resetsAt: window.resetsAt };
    }
  }
  if (!best) return null;
  const percentUsed = Math.min(100, Math.max(0, Math.round(best.ratio * 100)));
  const reset = resetText(best.resetsAt, now);
  return {
    percentUsed,
    text: `Claude weekly allowance: ${percentUsed}% used${reset ? `, ${reset}` : ''}.`,
  };
}
