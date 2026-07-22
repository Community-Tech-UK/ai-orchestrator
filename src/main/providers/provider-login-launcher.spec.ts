import { describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  buildTerminalLaunchCandidates,
  getProviderLoginCommand,
  launchProviderLogin,
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
