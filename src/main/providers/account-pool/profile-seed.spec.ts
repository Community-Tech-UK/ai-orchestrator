import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { seedClaudeProfileHome } from './claude-profile-seed';
import { CODEX_PROFILE_CONFIG_TOML, codexProfileHasAuth, seedCodexProfileHome } from './codex-profile-seed';

let root = '';
let legacy = '';
let home = '';
let noJson = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profile-seed-'));
  legacy = join(root, 'legacy-claude');
  home = join(root, 'profile');
  noJson = join(root, 'no-such-claude.json'); // hermetic default: never touch the real ~/.claude.json
  mkdirSync(join(legacy, 'commands'), { recursive: true });
  mkdirSync(join(legacy, 'projects'), { recursive: true });
  writeFileSync(join(legacy, 'settings.json'), '{}');
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('seedClaudeProfileHome', () => {
  it('links present shared entries, the session store under shared-store, and seeds onboarding', () => {
    const result = seedClaudeProfileHome(home, { legacyClaudeDir: legacy, continuation: 'shared-store', legacyClaudeJsonPath: noJson });
    expect(result.linked.sort()).toEqual(['commands', 'projects', 'settings.json']);
    expect(readlinkSync(join(home, 'projects'))).toBe(join(legacy, 'projects'));
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toEqual({ hasCompletedOnboarding: true });
    expect(result.onboardingSeeded).toBe(true);
  });

  it('does not link projects under replay', () => {
    const result = seedClaudeProfileHome(home, { legacyClaudeDir: legacy, continuation: 'replay', legacyClaudeJsonPath: noJson });
    expect(result.linked).not.toContain('projects');
  });

  it('is idempotent and never overwrites a real file or an existing link', () => {
    writeFileSync(join(home, 'settings.json'), '{"own":true}');
    writeFileSync(join(home, '.claude.json'), '{"theme":"dark"}');
    seedClaudeProfileHome(home, { legacyClaudeDir: legacy, continuation: 'shared-store', legacyClaudeJsonPath: noJson });
    const second = seedClaudeProfileHome(home, { legacyClaudeDir: legacy, continuation: 'shared-store', legacyClaudeJsonPath: noJson });
    expect(second).toEqual({ linked: [], onboardingSeeded: false, mcpServersSynced: false });
    expect(lstatSync(join(home, 'settings.json')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe('{"theme":"dark"}');
  });

  it('never writes through a dangling .claude.json symlink', () => {
    const outside = join(root, 'outside.json');
    symlinkSync(outside, join(home, '.claude.json'));
    seedClaudeProfileHome(home, { legacyClaudeDir: legacy, continuation: 'replay', legacyClaudeJsonPath: noJson });
    expect(() => lstatSync(outside)).toThrow();
  });

  it('merges the legacy account\'s user/local-scope MCP servers into a fresh profile', () => {
    const legacyClaudeJsonPath = join(root, 'home', '.claude.json');
    mkdirSync(join(root, 'home'), { recursive: true });
    writeFileSync(legacyClaudeJsonPath, JSON.stringify({
      oauthAccount: { email: 'legacy@example.com' },
      mcpServers: { lsp: { command: 'lsp-server' } },
    }));

    const result = seedClaudeProfileHome(home, { legacyClaudeDir: legacy, continuation: 'replay', legacyClaudeJsonPath });

    expect(result.mcpServersSynced).toBe(true);
    const written = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(written.mcpServers).toEqual({ lsp: { command: 'lsp-server' } });
    expect(written.oauthAccount).toBeUndefined(); // never leaks the legacy account's own identity
    expect(written.hasCompletedOnboarding).toBe(true);
  });

  it('resyncs newly-added shared MCP servers without disturbing the profile\'s own state', () => {
    const legacyClaudeJsonPath = join(root, 'home2', '.claude.json');
    mkdirSync(join(root, 'home2'), { recursive: true });
    writeFileSync(legacyClaudeJsonPath, JSON.stringify({ mcpServers: { lsp: { command: 'lsp-server' } } }));
    seedClaudeProfileHome(home, { legacyClaudeDir: legacy, continuation: 'replay', legacyClaudeJsonPath });

    // The profile accrues its own state (projects, numStartups) between spawns.
    const profileState = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ ...profileState, numStartups: 3 }));

    writeFileSync(legacyClaudeJsonPath, JSON.stringify({ mcpServers: { lsp: { command: 'lsp-server' }, imap: { command: 'imap-server' } } }));
    const second = seedClaudeProfileHome(home, { legacyClaudeDir: legacy, continuation: 'replay', legacyClaudeJsonPath });

    expect(second.mcpServersSynced).toBe(true);
    const written = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(written.mcpServers).toEqual({ lsp: { command: 'lsp-server' }, imap: { command: 'imap-server' } });
    expect(written.numStartups).toBe(3); // the profile's own accrued state survives the sync
  });

  it('does not touch a profile\'s .claude.json when the legacy account has no MCP servers', () => {
    const result = seedClaudeProfileHome(home, { legacyClaudeDir: legacy, continuation: 'replay', legacyClaudeJsonPath: noJson });
    expect(result.mcpServersSynced).toBe(false);
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toEqual({ hasCompletedOnboarding: true });
  });
});

describe('seedCodexProfileHome', () => {
  it('writes the file-store pin once and reports auth by existence only', () => {
    expect(seedCodexProfileHome(home)).toEqual({ configSeeded: true });
    expect(seedCodexProfileHome(home)).toEqual({ configSeeded: false });
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(CODEX_PROFILE_CONFIG_TOML);
    expect(codexProfileHasAuth(home)).toBe(false);
    writeFileSync(join(home, 'auth.json'), 'not parsed');
    expect(codexProfileHasAuth(home)).toBe(true);
  });
});
