/**
 * Pure display-formatting helpers for {@link PendingApprovalsBannerComponent}.
 * Kept separate from the component so risk classification and countdown
 * formatting are unit-testable without Angular or IPC.
 */

import {
  PERMISSION_SCOPE_WORDS,
  timedScopeWords,
  type PermissionScopeWords,
} from '../../../../shared/permissions/permission-scope-presentation';
import type { PendingApprovalItem } from '../../../../shared/types/permission-registry.types';

export type PermissionRiskTier = 'critical' | 'warning' | 'info';

export interface PermissionRiskInfo {
  label: string;
  tier: PermissionRiskTier;
}

/**
 * Known `PermissionRequest.action` values for the three flows LT-095 found
 * orphaned behind `PermissionRegistry` — see
 * `packages/contracts/src/channels/permission-registry.channels.ts`. Actions
 * outside this map (including any future PermissionRegistry consumer) still
 * render, just with a generic 'info' tier and a humanized label.
 */
const RISK_BY_ACTION: Record<string, PermissionRiskInfo> = {
  desktop_computer_use_grant: { label: 'Desktop app access (Computer Use)', tier: 'warning' },
  store_release_mutation: { label: 'Public app store release', tier: 'critical' },
  calendar_mutation: { label: 'Calendar change', tier: 'warning' },
  calendar_account_connect: { label: 'Microsoft account connection', tier: 'warning' },
  microsoft365_add_account: { label: 'Add a Microsoft 365 account', tier: 'warning' },
  microsoft365_mutation: { label: 'Microsoft 365 change', tier: 'warning' },
};

export function classifyPermissionRisk(action: string): PermissionRiskInfo {
  return RISK_BY_ACTION[action] ?? { label: humanizeAction(action), tier: 'info' };
}

function humanizeAction(action: string): string {
  return action.replace(/_/g, ' ').trim() || 'Permission';
}

export interface ApprovalScopeInfo {
  /** The allow button, worded like the command and browser cards. */
  allowLabel: string;
  /** One sentence saying how long an approval stands. */
  lasts: string;
}

/** Each of these asks again for the next operation, so one approval covers one operation. */
const ONE_OPERATION_ACTIONS = new Set([
  'store_release_mutation', 'calendar_mutation', 'calendar_account_connect', 'microsoft365_mutation',
]);

/** The "Always allow" button, offered only when the request says what it would cover. */
export function alwaysAllowLabel(item: Pick<PendingApprovalItem, 'alwaysAllowCovers'>): string | null {
  return item.alwaysAllowCovers ? PERMISSION_SCOPE_WORDS.always.allow : null;
}

function scopeInfo(words: PermissionScopeWords, tail = ''): ApprovalScopeInfo {
  return { allowLabel: words.allow, lasts: `Lasts ${words.lasts}${tail}.` };
}

/**
 * How long an approval stands, for the allow button and a "Lasts…" line.
 *
 * A registry approval is one yes or no: the requester decides the scope, not the
 * person answering, so this reads it from what the request says. Returns null
 * when the request does not say, so the card keeps a plain "Approve" and makes
 * no promise it cannot keep.
 *
 * Computer Use grants follow `DesktopGrantApprovalController`: `session` stops
 * after an hour (DEFAULT_GRANT_TTL_MS) and only works for the requesting
 * session; `boundedMinutes` is the same, for the stated minutes; `untilRevoked`
 * is durable and works from every session.
 */
export function describeApprovalScope(
  item: Pick<PendingApprovalItem, 'action' | 'details'>,
): ApprovalScopeInfo | null {
  if (ONE_OPERATION_ACTIONS.has(item.action)) return scopeInfo(PERMISSION_SCOPE_WORDS.once);
  if (item.action !== 'desktop_computer_use_grant') return null;

  const duration = item.details?.['duration'];
  if (duration === 'session') return scopeInfo(PERMISSION_SCOPE_WORDS.session, ', and no longer than an hour');
  if (duration === 'untilRevoked') return scopeInfo(PERMISSION_SCOPE_WORDS.always, ', in every session');
  const minutes = item.details?.['minutes'];
  if (duration === 'boundedMinutes' && typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) {
    return scopeInfo(timedScopeWords(minutes * 60_000), ', in this session only');
  }
  return null;
}

/** Renders a countdown like "42s left" / "2m 05s left", or "expiring…" once past deadline. */
export function formatRemaining(expiresAt: number, now: number): string {
  const remainingMs = expiresAt - now;
  if (remainingMs <= 0) {
    return 'expiring…';
  }
  const totalSeconds = Math.ceil(remainingMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s left`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s left`;
}

/** Compact "key: value · key: value" summary of a request's `details` blob. */
export function formatDetails(details: Record<string, unknown> | undefined): string {
  if (!details) {
    return '';
  }
  return Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join(' · ');
}
