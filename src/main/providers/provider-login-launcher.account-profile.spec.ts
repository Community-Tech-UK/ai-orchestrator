import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stateRoot = { current: '' };

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('./account-pool/provider-account-events', () => ({
  emitProviderAccountEvent: vi.fn(),
}));
vi.mock('./account-pool/provider-account-store', () => ({
  getProviderAccountStore: () => ({ getPoolPolicy: () => ({ continuation: 'replay' }) }),
}));
vi.mock('../cli/adapters/adapter-spawn-helpers', async () => {
  const actual = await vi.importActual<typeof import('../cli/adapters/adapter-spawn-helpers')>('../cli/adapters/adapter-spawn-helpers');
  return { ...actual, getProviderStateRoot: () => stateRoot.current };
});

import {
  buildClaudeProfileLoginCommand,
  buildCodexProfileLoginCommand,
  claudeLoginEmailFlag,
  copyAccountProfileLoginCommand,
  readClaudeOauthEmail,
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

  it('clears CLAUDE_CONFIG_DIR for the legacy profile so login cannot land in a pool home', () => {
    expect(buildClaudeProfileLoginCommand('legacy', 'darwin').command).toBe('env -u CLAUDE_CONFIG_DIR claude auth login');
    expect(buildClaudeProfileLoginCommand('legacy', 'win32').command).toBe('set "CLAUDE_CONFIG_DIR=" & claude auth login');
    expect(buildCodexProfileLoginCommand('legacy', 'darwin').command).toBe('codex login');
  });

  it('pins --email so the browser login cannot follow a different Claude account', () => {
    const login = buildClaudeProfileLoginCommand('legacy', 'darwin', 'shared-store', 'a@example.com');
    expect(login.command).toBe("env -u CLAUDE_CONFIG_DIR claude auth login --email 'a@example.com'");
    expect(login.hint).toContain('a@example.com');

    const derived = buildClaudeProfileLoginCommand('max-b', 'darwin', 'replay', 'b@example.com');
    const home = realpathSync(join(stateRoot.current, 'claude-cli-profiles', 'max-b'));
    expect(derived.command).toBe(`CLAUDE_CONFIG_DIR='${home}' claude auth login --email 'b@example.com'`);
    expect(buildClaudeProfileLoginCommand('max-b', 'win32', 'replay', 'b@example.com').command)
      .toBe(`set "CLAUDE_CONFIG_DIR=${home}" && claude auth login --email "b@example.com"`);
  });

  it('drops an email that is not safe to embed', () => {
    expect(claudeLoginEmailFlag("a@example.com'; touch /tmp/x", 'darwin')).toBe('');
    expect(buildClaudeProfileLoginCommand('legacy', 'darwin', 'shared-store', 'not-an-email').command)
      .toBe('env -u CLAUDE_CONFIG_DIR claude auth login');
  });

  it('reads only the oauth account email from a Claude config file', () => {
    const path = join(stateRoot.current, '.claude.json');
    writeFileSync(path, JSON.stringify({ oauthAccount: { emailAddress: 'owner@example.com', accessToken: 'secret' } }));
    expect(readClaudeOauthEmail(path)).toBe('owner@example.com');
    expect(readClaudeOauthEmail(join(stateRoot.current, 'missing.json'))).toBeUndefined();
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

  it('copies the derived Claude command without opening a terminal', () => {
    const written: string[] = [];
    const result = copyAccountProfileLoginCommand({ provider: 'claude', profileId: 'max-b' }, (text) => written.push(text));
    const home = realpathSync(join(stateRoot.current, 'claude-cli-profiles', 'max-b'));
    expect(written).toEqual([`CLAUDE_CONFIG_DIR='${home}' claude auth login`]);
    expect(result.hint).toMatch(/never sees the token/i);
  });

  it('rejects unsafe profile ids before any path is built', () => {
    expect(() => buildClaudeProfileLoginCommand('../x', 'darwin')).toThrow(/Invalid account profile ID/);
  });
});
