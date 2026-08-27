import type {
  DesktopAppDescriptor,
  DesktopPolicyStatus,
} from '../../shared/types/desktop-gateway.types';
import type { ComputerUseAutonomyLevel } from '../../shared/types/desktop-gateway-settings.types';

export interface DesktopGatewayPolicySettings {
  get(key: 'computerUseAllowedAppsJson' | 'computerUseDeniedAppsJson'): string;
}

/**
 * Harness's own UI. Denied at `guarded` and `trusted`, permitted only at
 * `unrestricted`.
 *
 * This is the one entry that survives James's 2026-08-26 authorisation, and not
 * out of caution about it: this window renders the Computer Use grant approvals
 * and the browser approval prompts. An agent that can click them approves its
 * own escalations, so every grant row would record a human decision that never
 * happened. The honest lever for "stop asking me" is
 * `computerUseRequireApprovalForInput: false`.
 */
const SELF_CONTROL_NAME_PATTERNS = [
  /ai\s*orchestrator/i,
  /\bharness\b/i,
];

/** Verified against electron-builder.json and the installed Harness.app plist. */
const SELF_CONTROL_BUNDLE_IDS = [
  'com.ai.orchestrator',
];

/**
 * Denied at `guarded` only. Terminals, provider apps, system security panes,
 * credential stores and payment surfaces.
 *
 * These are the ORIGINAL patterns, deliberately unchanged, because `guarded` has
 * to reproduce the previous behaviour exactly or it is not a usable revert.
 *
 * An earlier draft narrowed the loose ones (`security`, `privacy`, `credential`,
 * `shell`, `payment`) and anchored `wallet`/`stocks`, on the theory that the old
 * matcher's inclusion of `executablePath` in the haystack made them fire on
 * innocent apps installed under a matching path. That theory was wrong twice
 * over: `executablePath` is never populated (`mapApp()` in
 * `platform/darwin-helper-client.ts` sets appId, displayName, platform, bundleId,
 * pid and windows, and nothing else in the codebase writes it), so the
 * false-positive case was unreachable; and narrowing them silently stopped
 * denying real apps at `guarded` — "Wasabi Wallet", "ESET Cyber Security",
 * "Git Credential Manager" and "DuckDuckGo Privacy Browser" among them.
 *
 * Matching is still done per name field rather than over a joined string, and
 * `executablePath` is still excluded. That is defensive hygiene for the day a
 * driver does populate it, not a behaviour change today.
 */
const GUARDED_ONLY_NAME_PATTERNS = [
  // Terminals and shells
  /\bterminal\b/i,
  /\biterm\b/i,
  /\bwarp\b/i,
  /\balacritty\b/i,
  /\bkitty\b/i,
  /\bhyper\b/i,
  /\btmux\b/i,
  /\bshell\b/i,
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

const GUARDED_ONLY_BUNDLE_IDS = [
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
  level: ComputerUseAutonomyLevel = 'trusted',
): DesktopAppPolicyDecision {
  const builtInDenyReason = builtInDenyReasonForApp(app, level);
  if (builtInDenyReason) {
    return { status: 'denied', reason: builtInDenyReason };
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

function builtInDenyReasonForApp(
  app: DesktopAppDescriptor,
  level: ComputerUseAutonomyLevel,
): string | undefined {
  if (level !== 'unrestricted' && matchesSelfControl(app)) {
    return 'harness self-control denied';
  }
  if (level !== 'guarded') {
    return undefined;
  }
  if (app.bundleId && GUARDED_ONLY_BUNDLE_IDS.includes(app.bundleId)) {
    return 'built-in hard deny';
  }
  const fields = appNameFields(app);
  return GUARDED_ONLY_NAME_PATTERNS.some((pattern) => fields.some((field) => pattern.test(field)))
    ? 'built-in hard deny'
    : undefined;
}

function matchesSelfControl(app: DesktopAppDescriptor): boolean {
  // The authoritative check. `NSRunningApplication` reports an app bundle's main
  // process, and for Electron that IS this process — in a packaged build and a
  // dev build alike. Name and bundle-id matching cannot cover the dev build,
  // where the running bundle is stock Electron (`CFBundleName: Electron`,
  // `CFBundleIdentifier: com.github.Electron`); `app.setName('Harness (Dev)')`
  // does not rewrite the bundle, so a dev Harness window would otherwise be
  // reachable at `trusted` — the exact case this guard exists to prevent.
  //
  // Matching on `com.github.Electron` instead would be wrong: it would also
  // block every OTHER Electron app, including ones that are legitimate targets.
  if (app.pid !== undefined && app.pid === process.pid) {
    return true;
  }
  if (app.bundleId && SELF_CONTROL_BUNDLE_IDS.includes(app.bundleId)) {
    return true;
  }
  // The self-control guard DOES consider the executable path. Harness runs from a
  // path containing its own name, and letting an agent drive the app that renders
  // its own approval prompts is the one case worth a broader match.
  const fields = [...appNameFields(app), app.executablePath ?? ''].filter(Boolean);
  return SELF_CONTROL_NAME_PATTERNS.some((pattern) => fields.some((field) => pattern.test(field)));
}

/**
 * Name-ish fields, returned SEPARATELY rather than joined.
 *
 * Both matter. `executablePath` is excluded (see the note on
 * GUARDED_ONLY_NAME_PATTERNS), and keeping the fields apart is what lets an
 * anchored pattern like /^wallet$/ mean "an app actually called Wallet" instead
 * of being tested against "app-1 Wallet com.apple.wallet" and never matching.
 */
function appNameFields(app: DesktopAppDescriptor): string[] {
  return [app.appId, app.displayName, app.bundleId].filter((value): value is string => Boolean(value));
}

function matchesConfiguredApp(app: DesktopAppDescriptor, configured: string[]): boolean {
  return configured.some((candidate) =>
    candidate === app.appId
    || candidate === app.bundleId
    || candidate === app.executablePath
    || candidate.toLowerCase() === app.displayName.toLowerCase(),
  );
}
