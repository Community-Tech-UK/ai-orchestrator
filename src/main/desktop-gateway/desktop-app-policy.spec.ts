import { describe, expect, it } from 'vitest';
import { decideDesktopAppPolicy, type DesktopGatewayPolicySettings } from './desktop-app-policy';
import type { DesktopAppDescriptor } from '../../shared/types/desktop-gateway.types';
import type { ComputerUseAutonomyLevel } from '../../shared/types/desktop-gateway-settings.types';

function settings(allowed: string[] = [], denied: string[] = []): DesktopGatewayPolicySettings {
  return {
    get: (key) => (key === 'computerUseAllowedAppsJson'
      ? JSON.stringify(allowed)
      : JSON.stringify(denied)),
  };
}

function app(overrides: Partial<DesktopAppDescriptor> = {}): DesktopAppDescriptor {
  return {
    appId: 'app-1',
    displayName: 'Notes',
    bundleId: 'com.apple.Notes',
    executablePath: '/Applications/Notes.app/Contents/MacOS/Notes',
    ...overrides,
  } as DesktopAppDescriptor;
}

function statusAt(
  descriptor: DesktopAppDescriptor,
  level: ComputerUseAutonomyLevel,
  policySettings = settings(),
): string {
  return decideDesktopAppPolicy(descriptor, policySettings, level).status;
}

const HARNESS = app({
  appId: 'harness',
  displayName: 'Harness',
  bundleId: 'com.ai.orchestrator',
  executablePath: '/Applications/Harness.app/Contents/MacOS/Harness',
});

/**
 * Real-world app names that the ORIGINAL matcher denied at guarded via its loose
 * word patterns. An earlier draft narrowed those patterns and silently stopped
 * denying every app below; the hand-picked list under PREVIOUSLY_DENIED happened
 * to contain only survivors, so it did not notice. These are the survivors' blind
 * spot, kept as a separate fixture on purpose.
 */
const LOOSE_WORD_DENIED: Array<[string, DesktopAppDescriptor]> = [
  ['Wasabi Wallet', app({ displayName: 'Wasabi Wallet', bundleId: 'zksnacks.wasabiwallet' })],
  ['Coinbase Wallet', app({ displayName: 'Coinbase Wallet', bundleId: 'com.coinbase.wallet' })],
  ['ESET Cyber Security', app({ displayName: 'ESET Cyber Security', bundleId: 'com.eset.cyber' })],
  ['Sophos Endpoint Security', app({ displayName: 'Sophos Endpoint Security', bundleId: 'com.sophos.endpoint' })],
  ['Norton Security', app({ displayName: 'Norton Security', bundleId: 'com.symantec.norton' })],
  ['Bitdefender Total Security', app({ displayName: 'Bitdefender Total Security', bundleId: 'com.bitdefender.total' })],
  ['Git Credential Manager', app({ displayName: 'Git Credential Manager', bundleId: 'com.microsoft.gcm' })],
  ['DuckDuckGo Privacy Browser', app({ displayName: 'DuckDuckGo Privacy Browser', bundleId: 'com.duckduckgo.macos' })],
  ['Privacy Badger', app({ displayName: 'Privacy Badger', bundleId: 'org.eff.privacybadger' })],
  ['Stocks', app({ displayName: 'Stocks', bundleId: 'com.apple.stocks' })],
  ['Payment Terminal', app({ displayName: 'Payment Terminal', bundleId: 'com.acme.payments' })],
  ['Fish Shell', app({ displayName: 'Fish Shell', bundleId: 'com.fish.shell' })],
];

const PREVIOUSLY_DENIED: Array<[string, DesktopAppDescriptor]> = [
  ['Terminal', app({ displayName: 'Terminal', bundleId: 'com.apple.Terminal' })],
  ['iTerm', app({ displayName: 'iTerm2', bundleId: 'com.googlecode.iterm2' })],
  ['System Settings', app({ displayName: 'System Settings', bundleId: 'com.apple.systempreferences' })],
  ['Keychain Access', app({ displayName: 'Keychain Access', bundleId: 'com.apple.keychainaccess' })],
  ['1Password', app({ displayName: '1Password', bundleId: 'com.1password.1password' })],
  ['Bitwarden', app({ displayName: 'Bitwarden', bundleId: 'com.bitwarden.desktop' })],
  ['Claude', app({ displayName: 'Claude', bundleId: 'com.anthropic.claudefordesktop' })],
  ['Cursor', app({ displayName: 'Cursor', bundleId: 'com.todesktop.cursor' })],
  ['Wallet', app({ displayName: 'Wallet', bundleId: 'com.apple.wallet' })],
];

describe('decideDesktopAppPolicy — autonomy levels', () => {
  describe('guarded reproduces the original hard denials', () => {
    it.each(PREVIOUSLY_DENIED)('denies %s', (_name, descriptor) => {
      expect(statusAt(descriptor, 'guarded')).toBe('denied');
    });

    // Regression cover for the narrowing bug: these are denied ONLY by the loose
    // word patterns, so any future tightening of them fails here first.
    it.each(LOOSE_WORD_DENIED)('denies %s via the loose word patterns', (_name, descriptor) => {
      expect(statusAt(descriptor, 'guarded')).toBe('denied');
    });

    it('denies even when the app is on the configured allowlist', () => {
      const allowlisted = settings(['com.apple.Terminal']);
      const terminal = app({ displayName: 'Terminal', bundleId: 'com.apple.Terminal' });

      expect(statusAt(terminal, 'guarded', allowlisted)).toBe('denied');
    });
  });

  describe('trusted releases everything except Harness itself', () => {
    it.each(PREVIOUSLY_DENIED)('no longer denies %s', (_name, descriptor) => {
      expect(statusAt(descriptor, 'trusted')).toBe('needs_approval');
    });

    it('allows a released app outright when it is on the configured allowlist', () => {
      const allowlisted = settings(['com.apple.Terminal']);
      const terminal = app({ displayName: 'Terminal', bundleId: 'com.apple.Terminal' });

      expect(statusAt(terminal, 'trusted', allowlisted)).toBe('allowed');
    });

    it('still denies the Harness app, by bundle id and by name', () => {
      expect(statusAt(HARNESS, 'trusted')).toBe('denied');
      expect(statusAt(app({ displayName: 'AI Orchestrator', bundleId: 'com.example.other' }), 'trusted'))
        .toBe('denied');
    });

    it('reports the self-control reason rather than a generic hard deny', () => {
      expect(decideDesktopAppPolicy(HARNESS, settings(), 'trusted').reason)
        .toBe('harness self-control denied');
    });
  });

  describe('unrestricted removes the self-control guard too', () => {
    it('treats Harness like any other app', () => {
      expect(statusAt(HARNESS, 'unrestricted')).toBe('needs_approval');
    });

    it.each(PREVIOUSLY_DENIED)('does not deny %s', (_name, descriptor) => {
      expect(statusAt(descriptor, 'unrestricted')).toBe('needs_approval');
    });
  });

  describe('the configured denylist keeps working at every level', () => {
    it.each<ComputerUseAutonomyLevel>(['guarded', 'trusted', 'unrestricted'])('at %s', (level) => {
      const denied = settings([], ['com.apple.Notes']);

      expect(statusAt(app(), level, denied)).toBe('denied');
      expect(decideDesktopAppPolicy(app(), denied, level).reason).toBe('configured denylist');
    });
  });

  describe('the self-control guard identifies this process by pid', () => {
    // The authoritative check. A dev build runs the stock Electron bundle
    // (CFBundleName "Electron", CFBundleIdentifier "com.github.Electron"), which
    // no name or bundle-id rule here matches — so without the pid check a dev
    // Harness window is reachable at `trusted`, which is exactly what the guard
    // exists to prevent.
    const devHarness = app({
      appId: 'darwin-app:com.github.Electron',
      displayName: 'Electron',
      bundleId: 'com.github.Electron',
      pid: process.pid,
    });

    it('denies this process at trusted even though nothing about its name says Harness', () => {
      expect(statusAt(devHarness, 'trusted')).toBe('denied');
      expect(decideDesktopAppPolicy(devHarness, settings(), 'trusted').reason)
        .toBe('harness self-control denied');
    });

    it('does not deny a DIFFERENT Electron app', () => {
      const otherElectron = app({
        displayName: 'Electron',
        bundleId: 'com.github.Electron',
        pid: process.pid + 1,
      });

      expect(statusAt(otherElectron, 'trusted')).toBe('needs_approval');
    });

    it('still releases this process at unrestricted', () => {
      expect(statusAt(devHarness, 'unrestricted')).toBe('needs_approval');
    });
  });

  describe('an innocent app is not denied because of its path', () => {
    // The old matcher joined executablePath into the haystack and tested bare
    // words, so any app under a path containing one of these was hard-denied
    // with no way to allow it.
    // NOTE: `executablePath` is never populated by the real driver (`mapApp()` in
    // platform/darwin-helper-client.ts), so this is forward-looking hygiene
    // rather than a bug that could occur today. The words below DO deny by name.
    const PATH_WORDS = ['security', 'privacy', 'credential', 'shell', 'stocks', 'payment'];

    it.each(PATH_WORDS)('permits an app installed under a path containing %s', (word) => {
      const descriptor = app({
        displayName: 'Acme Reporter',
        bundleId: 'com.acme.reporter',
        executablePath: `/Users/someone/${word}/Acme.app/Contents/MacOS/Acme`,
      });

      expect(statusAt(descriptor, 'guarded')).toBe('needs_approval');
      expect(statusAt(descriptor, 'trusted')).toBe('needs_approval');
    });

    it('still denies a genuine password manager at guarded', () => {
      expect(statusAt(app({ displayName: '1Password 7', bundleId: 'com.acme.x' }), 'guarded'))
        .toBe('denied');
    });
  });

  it('defaults to trusted when no level is supplied', () => {
    expect(decideDesktopAppPolicy(HARNESS, settings()).status).toBe('denied');
    expect(
      decideDesktopAppPolicy(app({ displayName: 'Terminal', bundleId: 'com.apple.Terminal' }), settings()).status,
    ).toBe('needs_approval');
  });
});
