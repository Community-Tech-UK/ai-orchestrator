import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stateRoot = { current: '' };

vi.mock('../adapter-spawn-helpers', async () => {
  const actual = await vi.importActual<typeof import('../adapter-spawn-helpers')>('../adapter-spawn-helpers');
  return { ...actual, getProviderStateRoot: () => stateRoot.current };
});

import {
  CLAUDE_PROFILES_ROOT_DIR,
  CODEX_PROFILES_ROOT_DIR,
  assertSafeAccountProfileId,
  claudeKeychainServiceName,
  resolveAccountProfileHome,
} from './provider-account-home-resolver';

let tempRoot = '';

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'account-home-resolver-'));
  stateRoot.current = tempRoot;
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('resolveAccountProfileHome', () => {
  it('returns no path for the legacy profile and creates nothing', () => {
    expect(resolveAccountProfileHome({ provider: 'claude', profileId: 'legacy' })).toEqual({ kind: 'legacy' });
    expect(existsSync(join(tempRoot, CLAUDE_PROFILES_ROOT_DIR))).toBe(false);
  });

  it('derives realpath homes under a per-provider root with no trailing separator', () => {
    const claude = resolveAccountProfileHome({ provider: 'claude', profileId: 'max-a' });
    const codex = resolveAccountProfileHome({ provider: 'codex', profileId: 'max-a' });
    expect(claude).toEqual({ kind: 'derived', home: realpathSync(join(tempRoot, CLAUDE_PROFILES_ROOT_DIR, 'max-a')) });
    expect(codex).toEqual({ kind: 'derived', home: realpathSync(join(tempRoot, CODEX_PROFILES_ROOT_DIR, 'max-a')) });
    expect((claude as { home: string }).home.endsWith('/')).toBe(false);
  });

  it('is byte-stable across calls', () => {
    const first = resolveAccountProfileHome({ provider: 'claude', profileId: 'max-a' });
    const second = resolveAccountProfileHome({ provider: 'claude', profileId: 'max-a' });
    expect(second).toEqual(first);
  });

  it('does not create the home when asked not to', () => {
    resolveAccountProfileHome({ provider: 'codex', profileId: 'pro-b' }, { createIfMissing: false });
    expect(existsSync(join(tempRoot, CODEX_PROFILES_ROOT_DIR, 'pro-b'))).toBe(false);
  });

  it('refuses a pre-existing symlink that escapes the profiles root', () => {
    const outside = join(tempRoot, 'elsewhere');
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(tempRoot, CLAUDE_PROFILES_ROOT_DIR), { recursive: true });
    symlinkSync(outside, join(tempRoot, CLAUDE_PROFILES_ROOT_DIR, 'evil'));
    expect(() => resolveAccountProfileHome({ provider: 'claude', profileId: 'evil' })).toThrow(/outside the profiles root/);
  });

  it('rejects unsafe ids before building a path', () => {
    for (const id of ['..', '../x', 'a/b', 'Upper', '']) {
      expect(() => assertSafeAccountProfileId(id), id).toThrow(/Invalid account profile ID/);
      expect(() => resolveAccountProfileHome({ provider: 'codex', profileId: id }), id).toThrow(/Invalid account profile ID/);
    }
  });
});

describe('claudeKeychainServiceName', () => {
  it('matches the Claude Code derivation vectors', () => {
    expect(claudeKeychainServiceName(undefined)).toBe('Claude Code-credentials');
    expect(claudeKeychainServiceName('/Users/james/.claude-work')).toBe('Claude Code-credentials-c5a8e3ae');
    expect(claudeKeychainServiceName('/Users/james/.claude-work/')).toBe('Claude Code-credentials-20db9c00');
    expect(claudeKeychainServiceName('~/.claude-work')).toBe('Claude Code-credentials-250d1b22');
  });

  it('normalises to NFC before hashing', () => {
    const decomposed = '/Users/josé/.claude';
    const composed = '/Users/josé/.claude';
    expect(claudeKeychainServiceName(decomposed)).toBe(claudeKeychainServiceName(composed));
  });
});
