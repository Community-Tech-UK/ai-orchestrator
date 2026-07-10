import type {
  DesktopAppDescriptor,
  DesktopPolicyStatus,
} from '../../shared/types/desktop-gateway.types';

export interface DesktopGatewayPolicySettings {
  get(key: 'computerUseAllowedAppsJson' | 'computerUseDeniedAppsJson'): string;
}

const HARD_DENY_PATTERNS = [
  // Harness itself
  /ai\s*orchestrator/i,
  /\bharness\b/i,
  // Terminals and shells
  /\bterminal\b/i,
  /\biterm\b/i,
  /\bshell\b/i,
  /\bwarp\b/i,
  /\balacritty\b/i,
  /\bkitty\b/i,
  /\bhyper\b/i,
  /\btmux\b/i,
  // Provider / agent apps
  /\bclaude\b/i,
  /\bcodex\b/i,
  /\bgemini\b/i,
  /\bcopilot\b/i,
  /\bcursor\b/i,
  /\bantigravity\b/i,
  // System security / privacy settings
  /system settings/i,
  /system preferences/i,
  /securityagent/i,
  /\bsecurity\b/i,
  /\bprivacy\b/i,
  // Keychain / credential stores
  /keychain/i,
  /credential/i,
  // Password managers
  /1password/i,
  /bitwarden/i,
  /lastpass/i,
  /dashlane/i,
  /keeper/i,
  /nordpass/i,
  /password manager/i,
  // Payment / wallet
  /\bwallet\b/i,
  /\bpayment\b/i,
  /\bstocks\b/i,
];

const HARD_DENY_BUNDLE_IDS = [
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'com.apple.systempreferences',
  'com.apple.SecurityAgent',
  'com.apple.keychainaccess',
  'com.1password.1password',
  'com.agilebits.onepassword7',
  'com.bitwarden.desktop',
  'com.anthropic.claudefordesktop',
  'dev.warp.Warp-Stable',
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
  if (app.bundleId && HARD_DENY_BUNDLE_IDS.includes(app.bundleId)) {
    return 'built-in hard deny';
  }
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
