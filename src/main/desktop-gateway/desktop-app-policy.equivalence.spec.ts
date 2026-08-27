/**
 * `guarded` must reproduce the pre-autonomy-level behaviour. This is the test
 * that actually proves it.
 *
 * A hand-picked fixture list cannot: the first draft of this change narrowed
 * five loose patterns and anchored two more, and the nine-app list in
 * `desktop-app-policy.spec.ts` happened to contain only survivors, so it passed
 * while twelve realistic apps (Wasabi Wallet, ESET Cyber Security, Git
 * Credential Manager, DuckDuckGo Privacy Browser …) silently stopped being
 * denied.
 *
 * So the original matcher is reproduced verbatim below, from
 * `git show HEAD~:src/main/desktop-gateway/desktop-app-policy.ts` at the time of
 * the change, and the two are compared across a cross-product of realistic app
 * names and bundle ids. Do not "tidy" the copy — its value is being a frozen
 * record of the old behaviour.
 */
import { describe, expect, it } from 'vitest';
import { decideDesktopAppPolicy } from './desktop-app-policy';
import type { DesktopAppDescriptor } from '../../shared/types/desktop-gateway.types';

const OLD_HARD_DENY_PATTERNS = [
  /ai\s*orchestrator/i, /\bharness\b/i,
  /\bterminal\b/i, /\biterm\b/i, /\bshell\b/i, /\bwarp\b/i, /\balacritty\b/i,
  /\bkitty\b/i, /\bhyper\b/i, /\btmux\b/i,
  /\bclaude\b/i, /\bcodex\b/i, /\bgemini\b/i, /\bcopilot\b/i, /\bcursor\b/i,
  /\bantigravity\b/i,
  /system settings/i, /system preferences/i, /securityagent/i, /\bsecurity\b/i,
  /\bprivacy\b/i,
  /keychain/i, /credential/i,
  /1password/i, /bitwarden/i, /lastpass/i, /dashlane/i, /keeper/i, /nordpass/i,
  /password manager/i,
  /\bwallet\b/i, /\bpayment\b/i, /\bstocks\b/i,
];

const OLD_HARD_DENY_BUNDLE_IDS = [
  'com.apple.Terminal', 'com.googlecode.iterm2', 'com.apple.systempreferences',
  'com.apple.SecurityAgent', 'com.apple.keychainaccess', 'com.1password.1password',
  'com.agilebits.onepassword7', 'com.bitwarden.desktop',
  'com.anthropic.claudefordesktop', 'dev.warp.Warp-Stable',
];

function oldStatus(app: DesktopAppDescriptor): 'denied' | 'needs_approval' {
  if (app.bundleId && OLD_HARD_DENY_BUNDLE_IDS.includes(app.bundleId)) {
    return 'denied';
  }
  const haystack = [app.appId, app.displayName, app.bundleId, app.executablePath]
    .filter(Boolean).join(' ');
  return OLD_HARD_DENY_PATTERNS.some((p) => p.test(haystack)) ? 'denied' : 'needs_approval';
}

const NAMES = [
  'Terminal', 'iTerm2', 'Warp', 'Alacritty', 'kitty', 'Hyper', 'tmux', 'Fish Shell', 'xterm',
  'Claude', 'Codex', 'Gemini', 'Copilot', 'Cursor', 'Antigravity', 'Claude Code',
  'System Settings', 'System Preferences', 'SecurityAgent', 'ESET Cyber Security',
  'Sophos Endpoint Security', 'Norton Security', 'Kaspersky Internet Security',
  'Bitdefender Total Security', 'DuckDuckGo Privacy Browser', 'Privacy Badger',
  'Keychain Access', 'Git Credential Manager', 'Credential Helper',
  '1Password', 'Bitwarden', 'LastPass', 'Dashlane', 'Keeper Password Manager', 'NordPass',
  'Wallet', 'Coinbase Wallet', 'Wasabi Wallet', 'Payment Terminal', 'Stocks',
  'Notes', 'Safari', 'Slack', 'Figma', 'Xcode', 'Mail', 'Finder', 'Music', 'Photos',
  'Calendar', 'Visual Studio Code', 'Google Chrome', 'Firefox', 'Zoom', 'Spotify',
  'Preview', 'TextEdit', 'Harness', 'AI Orchestrator', 'Electron',
];

const BUNDLES = [
  'com.apple.Terminal', 'com.googlecode.iterm2', 'com.apple.systempreferences',
  'com.apple.SecurityAgent', 'com.apple.keychainaccess', 'com.1password.1password',
  'com.agilebits.onepassword7', 'com.bitwarden.desktop', 'com.anthropic.claudefordesktop',
  'dev.warp.Warp-Stable', 'com.apple.Notes', 'com.apple.Safari', 'com.acme.thing',
  'com.ai.orchestrator', 'com.github.Electron', 'com.apple.wallet', 'com.apple.stocks',
];

/** The shape `mapApp()` actually produces: no executablePath, pid present. */
function corpus(): DesktopAppDescriptor[] {
  const out: DesktopAppDescriptor[] = [];
  for (const displayName of NAMES) {
    for (const bundleId of BUNDLES) {
      out.push({
        appId: `darwin-app:${bundleId}`,
        displayName,
        platform: 'darwin',
        bundleId,
        pid: 4242,
      } as DesktopAppDescriptor);
    }
  }
  return out;
}

const settings = { get: () => '[]' } as never;

describe('guarded equivalence with the pre-change implementation', () => {
  it('never allows anything the old matcher denied', () => {
    const loosened = corpus().filter((app) =>
      oldStatus(app) === 'denied'
      && decideDesktopAppPolicy(app, settings, 'guarded').status !== 'denied');

    expect(loosened.map((a) => `${a.displayName} / ${a.bundleId}`)).toEqual([]);
  });

  it('tightens in exactly one place: Harness by bundle id', () => {
    // The old matcher did not know `com.ai.orchestrator`; it caught Harness only
    // by name. Adding the bundle id makes `guarded` stricter, never looser, and
    // this is the only intended divergence.
    const tightened = corpus().filter((app) =>
      oldStatus(app) !== 'denied'
      && decideDesktopAppPolicy(app, settings, 'guarded').status === 'denied');

    expect([...new Set(tightened.map((a) => a.bundleId))]).toEqual(['com.ai.orchestrator']);
  });
});
