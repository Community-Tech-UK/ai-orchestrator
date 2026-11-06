/**
 * Startup checks, in plain words and with a fix for each.
 *
 * The title-bar chip and the startup banner both start from the same question:
 * which checks need the user, and what do they press to deal with each one?
 * Keeping the answer here means the two surfaces cannot disagree, and the
 * Setup page's headlines stay in step with them.
 *
 * "Needs attention" means degraded or unavailable. A `disabled` check is a
 * tool or feature the user has no use for yet (an uninstalled CLI they never
 * set up, a switched-off server), so it never asks for anything.
 */

import type { ProviderId } from './types/provider-quota.types';
import type {
  StartupCapabilityCheck,
  StartupCapabilityOverallStatus,
  StartupCapabilityReport,
  StartupCheckFix,
} from './types/startup-capability.types';

const FIX_LABELS: Readonly<Record<StartupCheckFix, string>> = {
  accounts: 'Accounts',
  'remote-computers': 'Remote computers',
  browser: 'Browser',
  setup: 'Setup',
};

const KNOWN_FIXES: ReadonlySet<string> = new Set(Object.keys(FIX_LABELS));

const ACCOUNT_PROVIDERS: ReadonlySet<string> = new Set<ProviderId>([
  'claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok', 'opencode',
]);

export interface StartupFixAction {
  fix: StartupCheckFix;
  /** Button text: the place the button takes the user. */
  label: string;
  /** Set for `accounts`, so Copilot reaches its own accounts page. */
  provider?: ProviderId;
}

export function startupCheckNeedsAttention(check: StartupCapabilityCheck): boolean {
  return check.status === 'degraded' || check.status === 'unavailable';
}

/**
 * The checks that need the user, worst first: an unavailable check before a
 * degraded one, a critical one before an optional one, and report order inside
 * each tier. `limit` keeps the worst ones when a surface has room for a few.
 */
export function startupAttentionChecks(
  report: Pick<StartupCapabilityReport, 'checks'>,
  limit = Number.POSITIVE_INFINITY,
): StartupCapabilityCheck[] {
  const severity = (check: StartupCapabilityCheck): number =>
    (check.status === 'unavailable' ? 2 : 0) + (check.critical ? 1 : 0);
  return report.checks
    .map((check, index) => ({ check, index }))
    .filter(({ check }) => startupCheckNeedsAttention(check))
    .sort((a, b) => severity(b.check) - severity(a.check) || a.index - b.index)
    .slice(0, limit)
    .map(({ check }) => check);
}

function declaredFix(check: StartupCapabilityCheck): StartupCheckFix | null {
  const value = check.details?.['fix'];
  return typeof value === 'string' && KNOWN_FIXES.has(value) ? value as StartupCheckFix : null;
}

function providerOfCheck(check: StartupCapabilityCheck): ProviderId | undefined {
  if (!check.id.startsWith('provider.')) return undefined;
  const id = check.id.slice('provider.'.length);
  return ACCOUNT_PROVIDERS.has(id) ? id as ProviderId : undefined;
}

/**
 * The one button for a check. The probe's own `details.fix` wins; a check from
 * an older probe that names none falls back to where it used to lead (every
 * provider check opened Accounts) and to the page that owns each subsystem.
 */
export function startupCheckFixAction(check: StartupCapabilityCheck): StartupFixAction {
  const fix = declaredFix(check) ?? (
    check.id.startsWith('provider.') && check.id !== 'provider.any' ? 'accounts'
      : check.id === 'subsystem.remote-nodes' ? 'remote-computers'
        : check.id === 'subsystem.browser-automation' ? 'browser'
          : 'setup'
  );
  const provider = fix === 'accounts' ? providerOfCheck(check) : undefined;
  return { fix, label: FIX_LABELS[fix], ...(provider ? { provider } : {}) };
}

/** The same two headlines the Setup page uses, so the banner and the page agree. */
export function startupStatusHeadline(status: StartupCapabilityOverallStatus): string {
  switch (status) {
    case 'degraded': return 'A few things need attention';
    case 'failed': return 'Setup needs your attention';
    default: return 'Everything is ready';
  }
}

/** Title-bar chip text. Empty when everything is ready, because the chip is then not shown at all. */
export function startupChipLabel(status: StartupCapabilityOverallStatus): string {
  switch (status) {
    case 'degraded': return 'Startup needs attention';
    case 'failed': return 'Startup failed';
    default: return '';
  }
}
