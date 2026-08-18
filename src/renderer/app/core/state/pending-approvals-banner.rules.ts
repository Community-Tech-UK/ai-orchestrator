/**
 * Pure display-formatting helpers for {@link PendingApprovalsBannerComponent}.
 * Kept separate from the component so risk classification and countdown
 * formatting are unit-testable without Angular or IPC.
 */

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
};

export function classifyPermissionRisk(action: string): PermissionRiskInfo {
  return RISK_BY_ACTION[action] ?? { label: humanizeAction(action), tier: 'info' };
}

function humanizeAction(action: string): string {
  return action.replace(/_/g, ' ').trim() || 'Permission';
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
