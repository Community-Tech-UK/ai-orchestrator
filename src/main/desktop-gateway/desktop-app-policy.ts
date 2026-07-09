import type {
  DesktopAppDescriptor,
  DesktopPolicyStatus,
} from '../../shared/types/desktop-gateway.types';

export interface DesktopGatewayPolicySettings {
  get(key: 'computerUseAllowedAppsJson' | 'computerUseDeniedAppsJson'): string;
}

const HARD_DENY_PATTERNS = [
  /ai\s*orchestrator/i,
  /\bharness\b/i,
  /\bterminal\b/i,
  /\biterm\b/i,
  /\bshell\b/i,
  /system settings/i,
  /security/i,
  /privacy/i,
  /keychain/i,
  /1password/i,
  /password manager/i,
  /wallet/i,
  /payment/i,
];

export interface DesktopAppPolicyDecision {
  status: DesktopPolicyStatus;
  reason?: string;
}

export function decideDesktopAppPolicy(
  app: DesktopAppDescriptor,
  settings: DesktopGatewayPolicySettings,
): DesktopAppPolicyDecision {
  const hardDenyReason = hardDenyReasonForApp(app);
  if (hardDenyReason) {
    return { status: 'denied', reason: hardDenyReason };
  }
  if (matchesConfiguredApp(app, readAppList(settings.get('computerUseDeniedAppsJson')))) {
    return { status: 'denied', reason: 'configured denylist' };
  }
  if (matchesConfiguredApp(app, readAppList(settings.get('computerUseAllowedAppsJson')))) {
    return { status: 'allowed' };
  }
  return { status: 'needs_approval' };
}

export function readAppList(rawJson: string): string[] {
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function hardDenyReasonForApp(app: DesktopAppDescriptor): string | undefined {
  const haystack = [
    app.appId,
    app.displayName,
    app.bundleId,
    app.executablePath,
  ].filter(Boolean).join(' ');
  return HARD_DENY_PATTERNS.some((pattern) => pattern.test(haystack))
    ? 'built-in hard deny'
    : undefined;
}

function matchesConfiguredApp(app: DesktopAppDescriptor, configured: string[]): boolean {
  return configured.some((candidate) =>
    candidate === app.appId
    || candidate === app.bundleId
    || candidate === app.executablePath
    || candidate.toLowerCase() === app.displayName.toLowerCase(),
  );
}
