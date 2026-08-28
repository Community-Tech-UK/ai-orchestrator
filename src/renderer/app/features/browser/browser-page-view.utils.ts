import type {
  BrowserAllowedOrigin,
  BrowserActionClass,
  BrowserApprovalRequest,
  BrowserElementContext,
  BrowserGrantMode,
  BrowserGrantProposal,
  BrowserProfile,
  BrowserTarget,
} from '@contracts/types/browser';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';

export type BrowserPageView = 'browser' | 'permissions' | 'diagnostics' | 'unattended';
export type BrowserHealthTone = 'neutral' | 'ready' | 'warning' | 'error';
export type BrowserRequestKey =
  | 'refresh' | 'profiles' | 'targets' | 'audit' | 'approvals' | 'grants' | 'health'
  | 'snapshot' | 'screenshot' | 'extraction';

export class LatestBrowserRequestGate {
  private readonly generations = new Map<BrowserRequestKey, number>();

  constructor(private readonly onCurrentError: (error: unknown) => void) {}

  begin(key: BrowserRequestKey): () => boolean {
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    return () => this.generations.get(key) === generation;
  }

  async run<T>(key: BrowserRequestKey, request: () => Promise<T>): Promise<T | undefined> {
    const isCurrent = this.begin(key);
    return this.resolve(isCurrent, request);
  }

  async resolve<T>(isCurrent: () => boolean, request: () => Promise<T>): Promise<T | undefined> {
    try {
      const response = await request();
      return isCurrent() ? response : undefined;
    } catch (error) {
      if (isCurrent()) {
        this.onCurrentError(error);
      }
      return undefined;
    }
  }

  invalidate(key: BrowserRequestKey): void {
    this.begin(key);
  }
}

export interface BrowserProviderCapabilityRow {
  name: string;
  available: boolean;
  message: string;
}

export interface BrowserGatewayHealthPresentation {
  gateway: { label: string; tone: BrowserHealthTone };
  providers: {
    label: string;
    tone: BrowserHealthTone;
    rows: BrowserProviderCapabilityRow[];
  };
  channels: {
    label: string;
    tone: BrowserHealthTone;
    mcpBridgeLabel: string;
    localExtensionLabel: string;
    localExtensionSummary: string;
  };
}

const browserPageViews: readonly BrowserPageView[] = [
  'browser',
  'permissions',
  'diagnostics',
  'unattended',
];

export function sortBrowserNodes(nodes: RemoteNodeRosterEntry[]): RemoteNodeRosterEntry[] {
  const rank = (node: RemoteNodeRosterEntry): number =>
    node.capabilities.hasBrowserMcp ? 0 : node.capabilities.hasBrowserRuntime ? 1 : 2;
  return [...nodes].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function browserNodeReadinessLabel(node: RemoteNodeRosterEntry): string {
  if (node.status === 'disconnected') {
    return 'Disconnected';
  }
  if (node.capabilities.hasBrowserMcp) {
    return 'Ready';
  }
  return node.capabilities.hasBrowserRuntime ? 'Chrome only' : 'Off';
}

export function isBrowserProfileNodeSelectable(node: RemoteNodeRosterEntry): boolean {
  return node.capabilities.hasBrowserMcp && node.status !== 'disconnected';
}

export function formatBrowserUploadRoots(approval: BrowserApprovalRequest): string {
  return approval.proposedGrant.uploadRoots?.join(', ') ?? '';
}

export function browserApprovalConfirmationPhrase(
  approval: BrowserApprovalRequest,
  profiles: BrowserProfile[],
): string {
  const profileLabel = profiles.find((profile) => profile.id === approval.profileId)?.label;
  if (profileLabel) {
    return profileLabel;
  }
  const location = approval.origin ?? approval.url;
  if (location) {
    try {
      return new URL(location).host;
    } catch {
      return location;
    }
  }
  return approval.profileId;
}

export function buildBrowserGrantProposal(
  approval: BrowserApprovalRequest,
  mode: BrowserGrantMode,
  autonomousSubmit: boolean,
  autonomousDestructive: boolean,
): BrowserGrantProposal {
  const allowedActionClasses = new Set<BrowserActionClass>(
    approval.proposedGrant.allowedActionClasses,
  );
  if (mode === 'autonomous' && autonomousSubmit) {
    allowedActionClasses.add('submit');
  }
  if (mode === 'autonomous' && autonomousDestructive) {
    allowedActionClasses.add('destructive');
  }
  return {
    ...approval.proposedGrant,
    mode,
    allowedActionClasses: Array.from(allowedActionClasses),
    autonomous: mode === 'autonomous',
  };
}

export function browserGrantRequiresAutonomousConfirmation(grant: BrowserGrantProposal): boolean {
  return grant.allowedActionClasses.some((actionClass) =>
    actionClass === 'submit' || actionClass === 'destructive');
}

export function withoutBrowserRecordKey<T>(
  record: Record<string, T>,
  key: string,
): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));
}

export function filterBrowserTargets(
  targets: BrowserTarget[],
  rawQuery: string,
): BrowserTarget[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) {
    return targets;
  }
  return targets.filter((target) =>
    [target.title, target.url, target.id].some((value) =>
      value?.toLocaleLowerCase().includes(query),
    ),
  );
}

export function selectBrowserTarget(
  targets: BrowserTarget[],
  currentTargetId: string | null,
  preferredProfileId?: string,
): BrowserTarget | undefined {
  if (preferredProfileId) {
    return targets.find((target) =>
      target.id === currentTargetId && target.profileId === preferredProfileId)
      ?? targets.find((target) =>
        target.profileId === preferredProfileId && target.status === 'selected')
      ?? targets.find((target) => target.profileId === preferredProfileId);
  }
  return targets.find((target) => target.id === currentTargetId)
    ?? targets.find((target) => target.status === 'selected')
    ?? targets[0];
}

export function reconcileBrowserProfileSelection(
  profiles: BrowserProfile[],
  selectedProfileId: string | null,
  selectedTarget: BrowserTarget | null,
): string | null {
  if (selectedTarget?.profileId) {
    return selectedTarget.profileId;
  }
  return selectedProfileId && profiles.some((profile) => profile.id === selectedProfileId)
    ? selectedProfileId
    : profiles[0]?.id ?? null;
}

export function normalizeBrowserAllowedOrigins(raw: string): BrowserAllowedOrigin[] {
  return raw
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      let parsed: URL;
      try {
        const withScheme = /^https?:\/\//i.test(entry) ? entry : `https://${entry}`;
        parsed = new URL(withScheme.replace('://*.', '://wildcard.'));
      } catch {
        throw new Error(`Allowed origin is invalid: ${entry}`);
      }
      const wildcard = parsed.hostname.startsWith('wildcard.');
      return {
        scheme: parsed.protocol === 'http:' ? 'http' : 'https',
        hostPattern: wildcard ? parsed.hostname.replace(/^wildcard\./, '') : parsed.hostname,
        port: parsed.port ? Number(parsed.port) : undefined,
        includeSubdomains: wildcard || entry.includes('*.'),
      };
    });
}

export function nextBrowserPageView(
  current: BrowserPageView,
  key: string,
): BrowserPageView | null {
  const currentIndex = browserPageViews.indexOf(current);
  let nextIndex: number | null = null;
  if (key === 'ArrowRight') {
    nextIndex = (currentIndex + 1) % browserPageViews.length;
  } else if (key === 'ArrowLeft') {
    nextIndex = (currentIndex - 1 + browserPageViews.length) % browserPageViews.length;
  } else if (key === 'Home') {
    nextIndex = 0;
  } else if (key === 'End') {
    nextIndex = browserPageViews.length - 1;
  }
  return nextIndex === null ? null : browserPageViews[nextIndex]!;
}

export function formatBrowserGrantExpiry(expiresAt: number): string {
  return new Date(expiresAt).toLocaleString();
}

export function formatBrowserApprovalScope(approval: BrowserApprovalRequest): string {
  const origins = approval.proposedGrant.allowedOrigins
    .map((origin) =>
      `${origin.scheme}://${origin.includeSubdomains ? '*.' : ''}${origin.hostPattern}${origin.port ? `:${origin.port}` : ''}`,
    )
    .join(', ');
  const actions = approval.proposedGrant.allowedActionClasses.join(', ');
  return `${approval.proposedGrant.mode} · ${actions}${origins ? ` · ${origins}` : ''}`;
}

export function formatBrowserElementContext(element: BrowserElementContext): string {
  return [
    element.accessibleName,
    element.label,
    element.visibleText,
    element.role,
    element.inputType,
    element.inputName,
    element.placeholder,
    element.nearbyText,
  ].filter(Boolean).join(' · ');
}

export function formatBrowserAuditAction(action: string): string {
  return action
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function formatBrowserAuditAge(createdAt: number): string {
  const elapsedMs = Math.max(0, Date.now() - createdAt);
  if (elapsedMs < 60_000) return 'now';
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  return elapsedDays < 7 ? `${elapsedDays}d` : new Date(createdAt).toLocaleDateString();
}

export function presentBrowserGatewayHealth(value: unknown): BrowserGatewayHealthPresentation {
  const health = asRecord(value);
  const status = health?.['status'];
  const gateway = status === 'ready'
    ? { label: 'Gateway connected', tone: 'ready' as const }
    : status === 'partial'
      ? { label: 'Gateway degraded', tone: 'warning' as const }
      : status === 'missing'
        ? { label: 'Gateway unavailable', tone: 'error' as const }
        : { label: 'Checking gateway', tone: 'neutral' as const };

  const details = asRecord(health?.['providerCapabilityDetails']);
  const rows = details
    ? Object.entries(details).flatMap(([name, rawDetail]) => {
      const detail = asRecord(rawDetail);
      if (!detail) return [];
      const message = detail['message'] ?? detail['status'];
      return [{
        name,
        available: detail['available'] === true,
        message: typeof message === 'string' ? message : 'Unavailable',
      }];
    })
    : [];
  const availableProviders = rows.filter((row) => row.available).length;
  const providerTone: BrowserHealthTone = rows.length === 0
    ? 'neutral'
    : availableProviders === rows.length
      ? 'ready'
      : availableProviders > 0
        ? 'warning'
        : 'error';

  const mcpAvailable = asRecord(health?.['mcpBridge'])?.['available'];
  const localExtension = asRecord(health?.['localExtension']);
  const localState = localExtension?.['state'];
  const localSummary = localExtension?.['summary'];
  const channelStatus = presentChannelStatus(status, mcpAvailable, localState);

  return {
    gateway,
    providers: {
      label: rows.length ? `${availableProviders} of ${rows.length} available` : 'No provider data',
      tone: providerTone,
      rows,
    },
    channels: {
      ...channelStatus,
      mcpBridgeLabel: mcpAvailable === true
        ? 'MCP bridge available'
        : mcpAvailable === false
          ? 'MCP bridge unavailable'
          : 'MCP bridge status unknown',
      localExtensionLabel: formatLocalExtensionState(localState),
      localExtensionSummary: typeof localSummary === 'string'
        ? localSummary
        : 'No local extension health report.',
    },
  };
}

function presentChannelStatus(
  gatewayStatus: unknown,
  mcpAvailable: unknown,
  localExtensionState: unknown,
): { label: string; tone: BrowserHealthTone } {
  if (gatewayStatus === 'missing') return { label: 'Unavailable', tone: 'error' };
  if (mcpAvailable === false) return { label: 'Limited', tone: 'warning' };
  if (mcpAvailable !== true) return { label: 'Checking', tone: 'neutral' };
  if (localExtensionState === 'ready') return { label: 'Ready', tone: 'ready' };
  if (localExtensionState === 'silent' || localExtensionState === 'registration_broken') {
    return { label: 'Extension issue', tone: 'warning' };
  }
  if (localExtensionState === 'not_installed') return { label: 'MCP only', tone: 'neutral' };
  return { label: 'Extension unknown', tone: 'neutral' };
}

function formatLocalExtensionState(state: unknown): string {
  if (typeof state !== 'string') return 'Unknown';
  return state
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null;
}
