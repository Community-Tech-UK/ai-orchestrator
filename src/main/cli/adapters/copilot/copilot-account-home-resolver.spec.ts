import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const userDataPath = { current: '' };

vi.mock('../adapter-spawn-helpers', async () => {
  const actual = await vi.importActual<typeof import('../adapter-spawn-helpers')>(
    '../adapter-spawn-helpers',
  );
  return {
    ...actual,
    getCopilotStateRoot: () => userDataPath.current,
    getCopilotOrchestratorHome: () => join(userDataPath.current, 'copilot-cli-home'),
  };
});

import {
  COPILOT_PROFILES_ROOT_DIR,
  assertSafeCopilotProfileId,
  getCopilotProfilesRoot,
  isDirectChildOf,
  resolveCopilotProfileHome,
} from './copilot-account-home-resolver';

let tempRoot = '';

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'copilot-home-resolver-'));
  userDataPath.current = tempRoot;
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('isDirectChildOf', () => {
  it('rejects a sibling that merely shares a string prefix', () => {
    expect(isDirectChildOf('/a/b', '/a/bc')).toBe(false);
  });

  it('rejects the parent itself and grandchildren', () => {
    expect(isDirectChildOf('/a/b', '/a/b')).toBe(false);
    expect(isDirectChildOf('/a/b', '/a/b/c/d')).toBe(false);
  });

  it('accepts a direct child', () => {
    expect(isDirectChildOf('/a/b', '/a/b/c')).toBe(true);
  });
});

describe('assertSafeCopilotProfileId', () => {
  it('rejects traversal, absolute, and separator-bearing IDs', () => {
    for (const id of [
      '..',
      '../escape',
      'a/../../b',
      '/absolute',
      'C:\\windows',
      'has\\backslash',
      'has/slash',
      'Upper',
      '',
    ]) {
      expect(() => assertSafeCopilotProfileId(id), id).toThrow(/Invalid Copilot account profile ID/);
    }
  });

  it('accepts safe slugs', () => {
    expect(() => assertSafeCopilotProfileId('enterprise-1')).not.toThrow();
  });
});

describe('resolveCopilotProfileHome', () => {
  it('derives new-profile homes under the profiles root', () => {
    const home = resolveCopilotProfileHome('enterprise');
    // realpath'd — on macOS the temp root itself lives behind the /var symlink,
    // and the post-mkdir containment check resolves it.
    expect(home).toBe(realpathSync(join(tempRoot, COPILOT_PROFILES_ROOT_DIR, 'enterprise')));
    expect(existsSync(home)).toBe(true);
    expect(isDirectChildOf(getCopilotProfilesRoot(), home)).toBe(true);
  });

  it('keeps the legacy profile on the pre-existing copilot-cli-home path', () => {
    // Byte-identical to the value getCopilotOrchestratorHome() has always
    // returned — a single-account install must not have its state moved.
    expect(resolveCopilotProfileHome('legacy')).toBe(join(tempRoot, 'copilot-cli-home'));
    expect(resolveCopilotProfileHome('anything', { isLegacy: true })).toBe(
      join(tempRoot, 'copilot-cli-home'),
    );
  });

  it('refuses traversal and separator-bearing IDs before touching the filesystem', () => {
    for (const id of ['../escape', 'a/b', '..\\..\\escape', '/etc']) {
      expect(() => resolveCopilotProfileHome(id), id).toThrow(/Invalid Copilot account profile ID/);
    }
    expect(existsSync(join(tempRoot, COPILOT_PROFILES_ROOT_DIR))).toBe(false);
  });

  it('refuses a profile directory that is a symlink escaping the root', () => {
    const outside = join(tempRoot, 'outside-target');
    mkdirSync(outside, { recursive: true });
    const root = join(tempRoot, COPILOT_PROFILES_ROOT_DIR);
    mkdirSync(root, { recursive: true });
    symlinkSync(outside, join(root, 'sneaky'), 'dir');

    expect(() => resolveCopilotProfileHome('sneaky')).toThrow(/outside the profiles root/);
  });

  it('does not create the directory when createIfMissing is false', () => {
    const home = resolveCopilotProfileHome('preview', { createIfMissing: false });
    expect(home).toBe(join(tempRoot, COPILOT_PROFILES_ROOT_DIR, 'preview'));
    expect(existsSync(home)).toBe(false);
  });
});

describe('a filesystem failure must not leak the real path', () => {
  // Found by a fresh-eyes pass on 2026-08-30. Node embeds the real path in fs
  // error messages (`EACCES: permission denied, mkdir '<real path>'`). The
  // Copilot IPC handlers scrub that, but this throw also reaches surfaces that
  // do NOT: the mobile gateway returns `err.message` over the network to the
  // paired phone, and the channel router posts it into a Discord channel that
  // may be shared. Refusing to build the message here covers every surface.
  it('reports a profile-home failure without the path or the home markers', () => {
    // A FILE where the profiles root should be makes mkdir fail with ENOTDIR.
    writeFileSync(join(tempRoot, COPILOT_PROFILES_ROOT_DIR), 'not a directory');

    let message = '';
    try {
      resolveCopilotProfileHome('enterprise');
      throw new Error('expected resolveCopilotProfileHome to throw');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('enterprise');
    expect(message).toMatch(/ENOTDIR|writable/);
    // The three things that must never travel: the real path, either home
    // marker, and the temp root it lives under.
    expect(message).not.toContain(tempRoot);
    expect(message).not.toContain(COPILOT_PROFILES_ROOT_DIR);
    expect(message).not.toContain('copilot-cli-home');
  });
});
