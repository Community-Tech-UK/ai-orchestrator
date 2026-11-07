import { providerName } from '../../../../shared/display-names';
import { CLAUDE_ACCOUNT_WIDE_QUOTA_WINDOW_IDS, type ProviderQuotaSnapshot, type ProviderQuotaWindow } from '../../../../shared/types/provider-quota.types';
export interface ComposerQuotaNotice { text: string; short: string; strong: boolean; resetsAt: number | null }
export function quotaWindowsForSession(snapshot: ProviderQuotaSnapshot, model = ''): ProviderQuotaWindow[] {
  return snapshot.windows.filter(window => window.limit > 0 && Number.isFinite(window.used) && window.overage !== true
    && (window.unit !== 'usd' || window.overage === false) && (snapshot.provider !== 'claude'
      || CLAUDE_ACCOUNT_WIDE_QUOTA_WINDOW_IDS.has(window.id)
      || (window.id === 'claude.weekly-opus' && model.toLowerCase().includes('opus'))
      || (window.id === 'claude.weekly-sonnet' && model.toLowerCase().includes('sonnet'))));
}
/** "18:30" when the reset is today, "Mon 09:00" within the week, otherwise "14 Nov 09:00". */
function formatResetTime(resetsAt: number, now: number): string {
  const reset = new Date(resetsAt), today = new Date(now);
  const time = reset.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (reset.toDateString() === today.toDateString()) return time;
  const days = Math.round((new Date(reset).setHours(0, 0, 0, 0) - new Date(today).setHours(0, 0, 0, 0)) / 86_400_000);
  return days > 0 && days < 7
    ? `${reset.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`
    : `${reset.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
}
export function formatQuotaWindow(window: ProviderQuotaWindow, now: number): { label: string; remaining: string; reset: string } {
  const left = Math.max(0, 100 * (1 - window.used / window.limit));
  return { label: window.id === 'claude.5h' ? '5-hour' : window.label,
    remaining: left < 1 ? '<1%' : `${Math.round(left)}%`, reset: window.resetsAt ? formatResetTime(window.resetsAt, now) : '' };
}
export function buildComposerQuotaNotice(input: { snapshot?: ProviderQuotaSnapshot | null; sessionModel?: string;
  now: number; previous?: ComposerQuotaNotice | null }): ComposerQuotaNotice | null {
  const { snapshot, previous } = input;
  const stale = !snapshot?.ok || input.now - snapshot.takenAt > 30 * 60_000;
  if (stale && previous) return { ...previous, text: previous.text.replace(/ \(may be out of date\)$/, '') + ' (may be out of date)' };
  if (!snapshot) return null;
  const window = quotaWindowsForSession(snapshot, input.sessionModel).sort((a, b) => b.used / b.limit - a.used / a.limit)[0];
  if (!window || window.used / window.limit < 0.75) return null;
  const { label, remaining, reset } = formatQuotaWindow(window, input.now);
  const strong = window.used / window.limit >= 0.9;
  const provider = providerName(snapshot.provider);
  return { text: `${provider} ${label} limit: ${strong ? 'only ' : ''}${remaining} left${reset ? ` · resets ${reset}` : ''}${stale ? ' (may be out of date)' : ''}`,
    short: `${label === '5-hour' ? '5h' : label}: ${remaining} left`, strong, resetsAt: window.resetsAt };
}
