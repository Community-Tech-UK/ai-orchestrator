import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stateRoot = { current: '' };

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../cli/adapters/adapter-spawn-helpers', async () => {
  const actual = await vi.importActual<typeof import('../cli/adapters/adapter-spawn-helpers')>('../cli/adapters/adapter-spawn-helpers');
  return { ...actual, getProviderStateRoot: () => stateRoot.current };
});

import {
  buildClaudeProfileLoginCommand,
  buildCodexProfileLoginCommand,
} from './provider-login-launcher';

// Pure builders only: nothing here opens a terminal.
beforeEach(() => {
  stateRoot.current = mkdtempSync(join(tmpdir(), 'account login launcher '));
});

afterEach(() => {
  rmSync(stateRoot.current, { recursive: true, force: true });
});

describe('account-profile login commands', () => {
  it('quotes the derived Claude config dir and seeds onboarding', () => {
    const login = buildClaudeProfileLoginCommand('max-b', 'darwin', 'replay');
    const home = realpathSync(join(stateRoot.current, 'claude-cli-profiles', 'max-b'));
    expect(login.command).toBe(`CLAUDE_CONFIG_DIR='${home}' claude auth login`);
    expect(existsSync(join(home, '.claude.json'))).toBe(true);
    expect(buildClaudeProfileLoginCommand('max-b', 'win32').command)
      .toBe(`set "CLAUDE_CONFIG_DIR=${home}" && claude auth login`);
  });

  it('uses the plain command for the legacy profile', () => {
    expect(buildClaudeProfileLoginCommand('legacy', 'darwin').command).toBe('claude auth login');
    expect(buildCodexProfileLoginCommand('legacy', 'darwin').command).toBe('codex login');
  });

  it('builds a device-auth Codex login into a seeded fresh home', () => {
    const login = buildCodexProfileLoginCommand('pro-b', 'linux');
    const home = realpathSync(join(stateRoot.current, 'codex-cli-profiles', 'pro-b'));
    expect(login.command).toBe(`CODEX_HOME='${home}' codex login --device-auth`);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toContain('cli_auth_credentials_store = "file"');
  });

  it('refuses to log in over an existing Codex sign-in', () => {
    buildCodexProfileLoginCommand('pro-b', 'linux');
    writeFileSync(join(stateRoot.current, 'codex-cli-profiles', 'pro-b', 'auth.json'), '{}');
    expect(() => buildCodexProfileLoginCommand('pro-b', 'linux')).toThrow(/remove this account and add it again/);
  });

  it('rejects unsafe profile ids before any path is built', () => {
    expect(() => buildClaudeProfileLoginCommand('../x', 'darwin')).toThrow(/Invalid account profile ID/);
  });
});
