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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profile-seed-'));
  legacy = join(root, 'legacy-claude');
  home = join(root, 'profile');
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
    const result = seedClaudeProfileHome(home, { legacyClaudeDir: legacy, continuation: 'shared-store' });
    expect(result.linked.sort()).toEqual(['commands', 'projects', 'settings.json']);
    expect(readlinkSync(join(home, 'projects'))).toBe(join(legacy, 'projects'));
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toEqual({ hasCompletedOnboarding: true });
    expect(result.onboardingSeeded).toBe(true);
  });

  it('does not link projects under replay', () => {
    const result = seedClaudeProfileHome(home, { legacyClaudeDir: legacy, continuation: 'replay' });
    expect(result.linked).not.toContain('projects');
  });

  it('is idempotent and never overwrites a real file or an existing link', () => {
    writeFileSync(join(home, 'settings.json'), '{"own":true}');
    writeFileSync(join(home, '.claude.json'), '{"theme":"dark"}');
    seedClaudeProfileHome(home, { legacyClaudeDir: legacy, continuation: 'shared-store' });
    const second = seedClaudeProfileHome(home, { legacyClaudeDir: legacy, continuation: 'shared-store' });
    expect(second).toEqual({ linked: [], onboardingSeeded: false });
    expect(lstatSync(join(home, 'settings.json')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe('{"theme":"dark"}');
  });

  it('never writes through a dangling .claude.json symlink', () => {
    const outside = join(root, 'outside.json');
    symlinkSync(outside, join(home, '.claude.json'));
    seedClaudeProfileHome(home, { legacyClaudeDir: legacy, continuation: 'replay' });
    expect(() => lstatSync(outside)).toThrow();
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
