import { describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  buildCopilotProfileLoginCommand,
  buildTerminalLaunchCandidates,
  getProviderLoginCommand,
  launchProviderLogin,
  quotePathForTerminal,
} from './provider-login-launcher';

// These tests never exercise the spawn path: `launchProviderLogin` is only
// called for providers it must reject *before* touching child_process, and the
// command wiring is asserted through the pure builder instead. Mocking
// child_process here would be a silent-failure trap — a mock that fails to
// apply would open real terminal windows on the developer's machine.
describe('provider-login-launcher', () => {
  it('resolves login commands by short id and by ProviderDoctor probe key', () => {
    expect(getProviderLoginCommand('claude')?.command).toBe('claude auth login');
    expect(getProviderLoginCommand('claude-cli')?.command).toBe('claude auth login');
    expect(getProviderLoginCommand('codex')?.command).toBe('codex login');
    expect(getProviderLoginCommand('codex-cli')?.command).toBe('codex login');
    expect(getProviderLoginCommand('copilot')?.command).toBe('copilot login');
    expect(getProviderLoginCommand('cursor')?.command).toBe('cursor-agent login');
  });

  it('returns null for a provider with no known login command', () => {
    expect(getProviderLoginCommand('plugin:acme')).toBeNull();
    expect(getProviderLoginCommand('anthropic-api')).toBeNull();
  });

  it('builds an AppleScript launch that runs the command in Terminal on macOS', () => {
    const candidates = buildTerminalLaunchCandidates('claude auth login', 'darwin');

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      mode: 'osascript',
      file: '/usr/bin/osascript',
      terminal: 'Terminal',
    });
    expect(candidates[0].args).toContain(
      'tell application "Terminal" to do script "claude auth login"',
    );
  });

  it('builds a detached cmd.exe launch on Windows', () => {
    const candidates = buildTerminalLaunchCandidates('claude auth login', 'win32');

    expect(candidates).toEqual([
      {
        mode: 'spawn',
        file: 'cmd.exe',
        args: ['/c', 'start', '""', 'cmd.exe', '/k', 'claude auth login'],
        terminal: 'Command Prompt',
      },
    ]);
  });

  it('falls back across terminal emulators on Linux and keeps the window open', () => {
    const candidates = buildTerminalLaunchCandidates('codex login', 'linux');

    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.every((candidate) => candidate.mode === 'spawn')).toBe(true);
    expect(candidates[0].file).toBe('x-terminal-emulator');
    expect(candidates.find((c) => c.file === 'gnome-terminal')?.args).toContain(
      'codex login; exec $SHELL',
    );
  });

  it('every login command stays within the shell-safe character set', () => {
    const safe = /^[A-Za-z0-9 ._-]+$/;
    for (const provider of ['claude', 'codex', 'copilot', 'cursor', 'antigravity', 'gemini']) {
      const login = getProviderLoginCommand(provider);
      expect(login, provider).not.toBeNull();
      expect(safe.test(login!.command), `${provider}: ${login!.command}`).toBe(true);
    }
  });

  it('rejects a provider it has no sign-in command for without launching anything', async () => {
    await expect(launchProviderLogin('plugin:acme')).rejects.toThrow(
      /No known sign-in command/,
    );
  });
});

/**
 * Copilot profile sign-in. The renderer supplies a profile ID and a host; main
 * derives that profile's COPILOT_HOME. Nothing caller-controlled may reach a
 * shell, and the derived path must be quoted — the macOS userData path
 * contains a space, so an unquoted form would silently sign in to the wrong
 * (truncated) directory.
 */
describe('buildCopilotProfileLoginCommand', () => {
  it('rejects an invalid profile ID before any command is built', () => {
    for (const profileId of ['../escape', 'a/b', 'Upper', '', '/etc', 'a;rm -rf /']) {
      expect(() => buildCopilotProfileLoginCommand({ profileId }), profileId).toThrow(
        /Invalid Copilot account profile ID/,
      );
    }
  });

  it('rejects an invalid host before any command is built', () => {
    for (const host of [
      'GitHub.com',
      'github.com; rm -rf /',
      'https://github.com',
      'github.com/owner',
      '$(whoami)',
    ]) {
      expect(() => buildCopilotProfileLoginCommand({ profileId: 'legacy', host }), host).toThrow(
        /not a valid hostname/,
      );
    }
  });

  it('builds a quoted POSIX command with no interpolated caller fragment', () => {
    const built = buildCopilotProfileLoginCommand(
      { profileId: 'legacy', host: 'ghe.example.com' },
      'darwin',
    );
    expect(built.provider).toBe('copilot');
    expect(built.command).toMatch(/^COPILOT_HOME='.*' copilot login --host ghe\.example\.com$/);
    // The AppleScript wrapper embeds the command inside a double-quoted string,
    // so a double quote here would break out of it.
    expect(built.command).not.toContain('"');
  });

  it('omits --host when none is supplied', () => {
    const built = buildCopilotProfileLoginCommand({ profileId: 'legacy' }, 'darwin');
    expect(built.command).not.toContain('--host');
    expect(built.command.endsWith('copilot login')).toBe(true);
  });

  it('uses the cmd.exe set-assignment form on win32', () => {
    const built = buildCopilotProfileLoginCommand({ profileId: 'legacy' }, 'win32');
    expect(built.command).toMatch(/^set "COPILOT_HOME=.*" && copilot login$/);
  });
});

describe('quotePathForTerminal', () => {
  it('quotes so a path containing a space survives the shell', () => {
    expect(quotePathForTerminal('/Users/me/Application Support/x', 'darwin')).toBe(
      "'/Users/me/Application Support/x'",
    );
    expect(quotePathForTerminal('C:\\Users\\me\\x', 'win32')).toBe('"C:\\Users\\me\\x"');
  });

  it('refuses a path carrying a quote or shell metacharacter', () => {
    for (const value of [
      "/tmp/it's",
      '/tmp/"x"',
      '/tmp/$(whoami)',
      '/tmp/a;rm -rf /',
      '/tmp/a`id`',
      '/tmp/a|b',
      '/tmp/a\nb',
    ]) {
      expect(() => quotePathForTerminal(value, 'darwin'), value).toThrow(
        /cannot be safely quoted/,
      );
    }
  });

  it('accepts a backslash on win32 but not on POSIX', () => {
    expect(() => quotePathForTerminal('C:\\Users\\me', 'win32')).not.toThrow();
    expect(() => quotePathForTerminal('/tmp/a\\b', 'linux')).toThrow(/cannot be safely quoted/);
  });
});
